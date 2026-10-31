import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ArtifactRefSchema} from '@scan-to-make/contracts';

export const PRODUCTION_LIMITS = {sourceBytes:32*1024*1024, settingsBytes:8*1024*1024, manifestBytes:1024*1024};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const PreparedProductionSchema=z.strictObject({
 requestSha256:digest, producerIdentity:digest, sourceArtifact:ArtifactRefSchema,
 settingsArtifact:ArtifactRefSchema, manifestArtifact:ArtifactRefSchema,
 slicer:z.strictObject({version:z.string().min(1).max(128),binarySha256:digest}),
 // Present only on jobs produced through a configured printability gate;
 // pre-gate retained jobs keep loading unchanged.
 printability:z.strictObject({
  profileId:z.string().min(1).max(128),
  verdict:z.enum(['printable','printable-with-supports']),
  allowSupports:z.boolean(),
  reportArtifact:ArtifactRefSchema,
 }).optional(),
});
export type PreparedProduction=z.infer<typeof PreparedProductionSchema>;
export interface ProductionBytes {printable:Buffer;settings:Buffer;manifest:Buffer}
/** Trusted host capability, configured at construction; never supplied by a remote request. */
export interface PreparedProducer {
 readonly identity:string;
 readonly nozzleType?: ProducerNozzleType;
 produce(source:Buffer,overrides?:{enableSupport?:boolean},signal?:AbortSignal):Promise<ProductionBytes>;
}
export function productionHash(bytes:Uint8Array|string):string{return createHash('sha256').update(bytes).digest('hex');}
export function productionRef(bytes:Buffer,mediaType:string){return {sha256:productionHash(bytes),byteLength:bytes.length,mediaType};}
const outputRef=z.object({file:z.string(),sha256:digest,bytes:z.number().int().positive()});
const manifestSchema=z.object({
 schema:z.literal('scan-to-make.slicer-producer/0.1.0'),operatorOnly:z.literal(true),exitCode:z.literal(0),
 slicer:z.object({version:z.string().min(1).max(128),binary:z.object({sha256:digest})}),
 input:z.object({sha256:digest,bytes:z.number().int().positive(),expectedDigestChecked:z.literal(true)}),
 invocation:z.object({sandbox:z.object({kind:z.literal('macos-sandbox-exec'),path:z.literal('/usr/bin/sandbox-exec')})}),
 outputs:z.object({gcode:outputRef,exportedSettings:outputRef}),
});
export function verifyProductionBytes(source:Buffer,input:ProductionBytes,maxPrintableBytes:number){
 for(const [name,bytes,max] of [['source',source,PRODUCTION_LIMITS.sourceBytes],['printable',input.printable,maxPrintableBytes],['settings',input.settings,PRODUCTION_LIMITS.settingsBytes],['manifest',input.manifest,PRODUCTION_LIMITS.manifestBytes]] as const){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max)throw new Error(`Produced ${name} byte limit exceeded`);
 }
 const settings=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.settings));
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error('Produced settings must be an object');
 const m=manifestSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.manifest)));
 const matches=(ref:{sha256:string;bytes:number},bytes:Buffer)=>ref.sha256===productionHash(bytes)&&ref.bytes===bytes.length;
 if(!matches(m.input,source)||!matches(m.outputs.gcode,input.printable)||!matches(m.outputs.exportedSettings,input.settings)||
  m.outputs.gcode.file!=='plate_1.gcode'||m.outputs.exportedSettings.file!=='exported-settings.json')throw new Error('Producer manifest artifact identity mismatch');
 return {sourceArtifact:productionRef(source,'model/stl'),settingsArtifact:productionRef(input.settings,'application/json'),
  manifestArtifact:productionRef(input.manifest,'application/json'),slicer:{version:m.slicer.version,binarySha256:m.slicer.binary.sha256}};
}

import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdtemp, open, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';

export const producerBedTypeSchema = z.enum(['textured_plate', 'cool_plate', 'engineering_plate', 'hot_plate']);
export type ProducerBedType = z.infer<typeof producerBedTypeSchema>;
export const producerNozzleTypeSchema = z.enum(['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']);
export type ProducerNozzleType = z.infer<typeof producerNozzleTypeSchema>;
export interface PreparedProducerConfiguration {
  python: string; script: string; expectedScriptSha256: string; bundle: string;
  expectedVersion: string; expectedBinarySha256: string;
  machine: string; process: string; filament: string; timeoutSeconds?: number;
  bedType?: ProducerBedType; nozzleType?: ProducerNozzleType; enableSupport?: boolean;
}
export const preparedProducerConfigurationSchema = z.strictObject({
  python: z.string().refine(isAbsolute), script: z.string().refine(isAbsolute),
  expectedScriptSha256: digest, bundle: z.string().refine(isAbsolute),
  expectedVersion: z.string().min(1).max(128), expectedBinarySha256: digest,
  machine: z.string().min(1).max(256), process: z.string().min(1).max(256),
  filament: z.string().min(1).max(256), timeoutSeconds: z.number().int().min(1).max(120).default(45),
  bedType: producerBedTypeSchema.optional(), nozzleType: producerNozzleTypeSchema.optional(),
  enableSupport: z.boolean().optional(),
});
async function readProductionFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('Producer file byte limit exceeded');
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const next = await file.read(buffer, length, buffer.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length !== stat.size) throw new Error('Producer file changed while reading');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await file.close(); }
}
// Turn cancellation into an exception so the producer reaps its slicer group.
// Defer it across Popen until ownership is recorded; no child is left untracked.
const RUNNER = String.raw`
import os, runpy, signal, subprocess, sys
owned = []
spawning = False
pending = False
original_popen = subprocess.Popen

def cancel(signum, frame):
    global pending
    pending = True
    if not spawning:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SystemExit(130)

def tracked_popen(*args, **kwargs):
    global spawning
    spawning = True
    try:
        child = original_popen(*args, **kwargs)
        grouped = kwargs.get('start_new_session', False)
        owned.append((child, grouped))
        if grouped:
            os.write(3, (str(child.pid) + '\n').encode('ascii'))
            original_wait = child.wait
            def tracked_wait(*args, **kwargs):
                result = original_wait(*args, **kwargs)
                os.write(3, ('-' + str(child.pid) + '\n').encode('ascii'))
                return result
            child.wait = tracked_wait
    finally:
        spawning = False
    if pending:
        cancel(signal.SIGTERM, None)
    return child

signal.signal(signal.SIGTERM, cancel)
subprocess.Popen = tracked_popen
sys.argv = sys.argv[1:]
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for child, grouped in owned:
        if child.poll() is None:
            try:
                if grouped: os.killpg(child.pid, signal.SIGKILL)
                else: child.kill()
            except ProcessLookupError: pass
            child.wait(timeout=2)
`;

/** Pinned operator configuration. Requests supply source bytes only. */
export function createPreparedProducer(configuration: PreparedProducerConfiguration): PreparedProducer {
  const config = preparedProducerConfigurationSchema.parse(configuration);
  const identity = productionHash(JSON.stringify({adapterVersion: 2, ...config}));
  return {identity, nozzleType: config.nozzleType, async produce(source, overrides, signal) {
    if (process.platform !== 'darwin') throw new Error('Enforced slicer isolation requires macOS');
    if (signal?.aborted) throw new Error('Production cancelled');
    if (!Buffer.isBuffer(source) || !source.length || source.length > PRODUCTION_LIMITS.sourceBytes) throw new Error('Produced source byte limit exceeded');
    const original = Buffer.from(source);
    const script = await readProductionFile(config.script, 1024 * 1024);
    if (productionHash(script) !== config.expectedScriptSha256) throw new Error('Producer script identity mismatch');
    const folder = await mkdtemp(join(tmpdir(), 'prepared-production-'));
    try {
      const input = join(folder, 'source.stl'), executable = join(folder, 'producer.py'), output = join(folder, 'output');
      await writeFile(input, original, {flag: 'wx', mode: 0o400});
      await writeFile(executable, script, {flag: 'wx', mode: 0o400});
      const argv = ['-I', '-B', '-c', RUNNER, executable, input, '--out', output,
        '--bundle', config.bundle, '--machine', config.machine, '--process', config.process,
        '--filament', config.filament, '--expected-version', config.expectedVersion,
        '--expected-binary-sha256', config.expectedBinarySha256,
        '--expected-input-sha256', productionHash(original), '--expected-input-bytes', String(original.length),
        '--timeout', String(config.timeoutSeconds)];
      if (config.bedType) argv.push('--bed-type', config.bedType);
      if (config.nozzleType) argv.push('--nozzle-type', config.nozzleType);
      const enableSupport = overrides?.enableSupport ?? config.enableSupport;
      if (enableSupport !== undefined) argv.push('--enable-support', enableSupport ? '1' : '0');
      if (signal?.aborted) throw new Error('Production cancelled');
      const child = spawn(config.python, argv, {cwd: folder, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: {PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: folder}});
      let failure: string | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const ownedGroups = new Set<number>();
      const killOwnedGroups = () => {
        for (const pid of ownedGroups) {
          try { process.kill(-pid, 'SIGKILL'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'Producer group cleanup failed';
          }
        }
        ownedGroups.clear();
      };
      const stop = (reason: string) => {
        if (failure) return;
        failure = reason; child.kill('SIGTERM');
        killTimer = setTimeout(() => {killOwnedGroups(); child.kill('SIGKILL');}, 5000);
      };
      // A dedicated pipe carries only owned session-group IDs from the pinned
      // wrapper. Keep ownership if Python is forcibly killed before its finally.
      let ownershipBuffer = '', ownershipBytes = 0;
      child.stdio[3]!.on('data', (bytes: Buffer) => {
        ownershipBytes += bytes.length;
        if (ownershipBytes > 4096) {stop('Producer ownership limit exceeded'); return;}
        ownershipBuffer += bytes.toString('ascii');
        for (let end; (end = ownershipBuffer.indexOf('\n')) >= 0;) {
          const line = ownershipBuffer.slice(0, end); ownershipBuffer = ownershipBuffer.slice(end + 1);
          if (!/^-?[1-9][0-9]{0,9}$/.test(line)) {stop('Invalid producer ownership record'); continue;}
          const pid = Number(line);
          if (Math.abs(pid) > 2147483647) {stop('Invalid producer ownership record'); continue;}
          if (pid < 0) ownedGroups.delete(-pid); else ownedGroups.add(pid);
        }
      });
      let logBytes = 0;
      const drain = (bytes: Buffer) => {logBytes += bytes.length; if (logBytes > 64 * 1024) stop('Producer log limit exceeded');};
      child.stdout!.on('data', drain); child.stderr!.on('data', drain);
      const finished = new Promise<number | null>(resolve => {
        child.once('error', () => {failure = 'Producer launch failed';}); child.once('close', resolve);
      });
      const abort = () => stop('Production cancelled');
      const timer = setTimeout(() => stop('Production timed out'), config.timeoutSeconds * 1000 + 5000);
      signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
      try {
        const code = await finished;
        if (failure || code !== 0) throw new Error(failure ?? 'Producer failed');
      } finally {clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); killOwnedGroups();}
      if (signal?.aborted) throw new Error('Production cancelled');
      const result = {
        printable: await readProductionFile(join(output, 'plate_1.gcode'), 64 * 1024 * 1024),
        settings: await readProductionFile(join(output, 'exported-settings.json'), PRODUCTION_LIMITS.settingsBytes),
        manifest: await readProductionFile(join(output, 'manifest.json'), PRODUCTION_LIMITS.manifestBytes),
      };
      const evidence = verifyProductionBytes(original, result, 64 * 1024 * 1024);
      if (evidence.slicer.version !== config.expectedVersion || evidence.slicer.binarySha256 !== config.expectedBinarySha256) throw new Error('Produced slicer identity mismatch');
      if (productionHash(await readProductionFile(config.script, 1024 * 1024)) !== config.expectedScriptSha256) throw new Error('Producer script changed during production');
      return result;
    } finally { await rm(folder, {recursive: true, force: true}); }
  }};
}
