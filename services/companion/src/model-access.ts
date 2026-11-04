import {constants} from 'node:fs';
import {lstat,open,rename,rm,link} from 'node:fs/promises';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {ProjectWorker,WorkerRun} from './touchup/runner.js';
import {publicTouchupText} from './touchup/runner.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlFailure} from './local-control-protocol.js';
import {ModelAccessChoiceSchema,ModelAccessRecordSchema,type ModelAccessCheck,type ModelAccessRecord} from './model-access-protocol.js';
import {createModelWorker,type ModelWorker,type ModelWorkerOptions} from './model-access-worker.js';

async function writeRecord(path:string,record:ModelAccessRecord,createOnly=false) {
  const temporary = path+'.'+randomUUID();
  try {
    const file = await open(temporary,'wx',0o600);
    try { await file.writeFile(JSON.stringify(record)+'\n'); await file.sync(); } finally { await file.close(); }
    // Publishing a hard link is atomic and exclusive: concurrent initialization
    // cannot replace another owner's complete record with a fresh default.
    if (createOnly) await link(temporary,path);
    else await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
}

/** Single companion owner; choice writes are atomic and serialized with CAS.
 * Connection results are deliberately ephemeral and bound to the exact revision. */
export class ModelAccessService {
  private check?:ModelAccessCheck;
  private listeners = new Set<()=>void>();
  onChange(listener:()=>void) {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private changed() {for(const listener of this.listeners)listener();}
  private controller?:AbortController;
  private writes:Promise<unknown> = Promise.resolve();
  private constructor(private path:string,private record:ModelAccessRecord,private worker:ModelWorker) {}
  static async open(directory:string,worker:ModelWorker = createModelWorker(process.env.SCAN_TO_MAKE_MODEL_WORKER), options:{legacyClaude?:boolean} = {}):Promise<ModelAccessService> {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new Error('Model access requires private storage');
    const path = join(directory,'model-access.json');
    let record:ModelAccessRecord;
    try {
      const file = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0 || info.uid !== parent.uid) throw new Error('Invalid model access storage');
        record = ModelAccessRecordSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record = {version:1,revision:randomUUID(),choice:{kind:options.legacyClaude?'claude-code':'none'}};
      try { await writeRecord(path,record,true); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'EEXIST') return ModelAccessService.open(directory,worker,options);
        throw failure;
      }
    }
    return new ModelAccessService(path,record,worker);
  }
  get() { return structuredClone({revision:this.record.revision,choice:this.record.choice,check:this.check ?? null}); }
  async set(expectedRevision:string,raw:unknown) {
    const choice = ModelAccessChoiceSchema.parse(raw);
    const operation = this.writes.then(async () => {
      if (expectedRevision.toLowerCase() !== this.record.revision) throw new ControlFailure('conflict');
      const record:ModelAccessRecord = {version:1,revision:randomUUID(),choice};
      await writeRecord(this.path,record);
      this.controller?.abort(); this.controller = undefined; this.check = undefined;
      this.record = record; this.changed();
      return this.get();
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  startCheck(revision:string) {
    if (revision.toLowerCase() !== this.record.revision) throw new ControlFailure('conflict');
    if (this.check?.state === 'checking') return this.get();
    const check:ModelAccessCheck = {id:randomUUID(),revision:this.record.revision,state:this.record.choice.kind === 'none' ? 'skipped' : 'checking'};
    this.check = check;
    if (check.state === 'skipped') { check.outcome = 'skipped'; this.changed(); return this.get(); }
    const controller = new AbortController(); this.controller = controller; this.changed();
    void this.worker(structuredClone(this.record.choice),['check'],{signal:controller.signal,timeoutMs:150000}).then(result => {
      if (this.check !== check || controller.signal.aborted) return;
      const value:unknown = JSON.parse(result.stdout);
      const response = value as {ok?:unknown;outcome?:unknown};
      check.state = result.exitCode === 0 && response?.ok === true ? 'connected' : 'failed';
      if (check.state === 'failed') {
        const outcomes = ['auth-failed','needs-gui-session','timed-out','cancelled','failed'] as const;
        check.outcome = outcomes.find(value => value === response?.outcome) ?? 'failed';
      }
      this.changed();
    }).catch(() => { if (this.check === check && !controller.signal.aborted) { check.state = 'failed'; check.outcome = 'failed'; this.changed(); } });
    return this.get();
  }
  /** Snapshot before any preparation/queue wait. Settings writes cancel checks, never jobs. */
  projectWorker():ProjectWorker {
    const choice = structuredClone(this.record.choice);
    if (choice.kind === 'none') throw new ControlFailure('unavailable','AI is off. Choose an AI provider in Settings before starting a model job.');
    return async (inv,options) => {
      options.signal?.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(),'stm-project-worker-'));
      try {
        const path = join(dir,'request.json');
        // No caller environment or redaction secrets cross into the keyed helper.
        await writeFile(path,JSON.stringify({args:inv.args,cwd:inv.cwd,mcpConfig:inv.mcpConfig,timeoutMs:options.timeoutMs,maxToolCalls:options.maxToolCalls}),{mode:0o600});
        const result = await this.worker(choice,['project',path],{signal:options.signal,timeoutMs:(options.timeoutMs ?? 900000)+15000,onProgress:options.onProgress});
        if (result.exitCode !== 0) throw new Error('The selected AI worker could not start. Check its login or API key in Settings.');
        const run = JSON.parse(result.stdout) as WorkerRun;
        if (!run || typeof run.toolCalls !== 'number' || typeof run.seconds !== 'number') throw new Error('Invalid model worker response');
        return {...run,publicText:(text:string)=>publicTouchupText(text,inv.redactionEnv)};
      } finally { await rm(dir,{recursive:true,force:true}); }
    };
  }
  cleanupSnapshot() {
    const choice = structuredClone(this.record.choice);
    const access:import('./ai-tweak.js').ModelAccess = choice.kind === 'api'
      ? {kind:choice.kind,provider:choice.provider,model:choice.model,keyEnv:'SCAN_TO_MAKE_MODEL_KEY'}
      : choice.kind === 'endpoint' ? {kind:choice.kind,url:choice.url,model:choice.model,...(choice.keychainRef?{keyEnv:'SCAN_TO_MAKE_MODEL_KEY'}:{})} : choice;
    return {access,revision:this.record.revision,worker:(args:string[],options:ModelWorkerOptions = {})=>this.worker(choice,['run',...args],options)};
  }
  /** Cleanup job integration: one immutable selection per invocation. Secrets are
   * resolved by the app at spawn, never copied into the companion environment. */
  run(args:string[],options:ModelWorkerOptions = {}) {
    return this.worker(structuredClone(this.record.choice),['run',...args],options);
  }
  close() { this.controller?.abort(); this.listeners.clear(); }
}
