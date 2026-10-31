import {constants} from 'node:fs';
import {lstat,open,rename,rm,link} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlFailure} from './local-control-protocol.js';
import {ModelAccessChoiceSchema,ModelAccessRecordSchema,type ModelAccessCheck,type ModelAccessChoice,type ModelAccessRecord} from './model-access-protocol.js';
import {ModelAccessEnvironment} from '@scan-to-make/contracts/model-access';
import type {ModelAccess} from './ai-tweak.js';
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
  private controller?:AbortController;
  private writes:Promise<unknown> = Promise.resolve();
  private constructor(private path:string,private record:ModelAccessRecord,private worker:ModelWorker) {}
  static async open(directory:string,worker:ModelWorker = createModelWorker(process.env.SCAN_TO_MAKE_MODEL_WORKER)):Promise<ModelAccessService> {
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
      record = {version:1,revision:randomUUID(),choice:{kind:'none'}};
      try { await writeRecord(path,record,true); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'EEXIST') return ModelAccessService.open(directory,worker);
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
      this.record = record;
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
    if (check.state === 'skipped') { check.outcome = 'skipped'; return this.get(); }
    const controller = new AbortController(); this.controller = controller;
    void this.worker(structuredClone(this.record.choice),['check'],{signal:controller.signal,timeoutMs:150000}).then(result => {
      if (this.check !== check || controller.signal.aborted) return;
      const value:unknown = JSON.parse(result.stdout);
      const response = value as {ok?:unknown;outcome?:unknown};
      check.state = result.exitCode === 0 && response?.ok === true ? 'connected' : 'failed';
      if (check.state === 'failed') {
        const outcomes = ['auth-failed','needs-gui-session','timed-out','cancelled','failed'] as const;
        check.outcome = outcomes.find(value => value === response?.outcome) ?? 'failed';
      }
    }).catch(() => { if (this.check === check && !controller.signal.aborted) { check.state = 'failed'; check.outcome = 'failed'; } });
    return this.get();
  }
  /** Cleanup job integration: one immutable selection per invocation. Secrets are
   * resolved by the app at spawn, never copied into the companion environment. */
  run(args:string[],options:ModelWorkerOptions = {}) {
    return this.worker(structuredClone(this.record.choice),['run',...args],options);
  }
  close() { this.controller?.abort(); }
}

/**
 * The cleanup AI step's route for a saved choice (KAN-198): kind, provider, endpoint and model. A keyed
 * choice's secret is resolved by the signed helper into SCAN_TO_MAKE_MODEL_KEY; the companion never sees it.
 */
export function accessFromChoice(choice:ModelAccessChoice):ModelAccess{
  switch (choice.kind) {
    case 'none': case 'claude-code': case 'codex-cli': return {kind:choice.kind};
    case 'api': return {kind:'api',provider:choice.provider,model:choice.model,keyEnv:ModelAccessEnvironment.secret};
    case 'endpoint': return {kind:'endpoint',url:choice.url,model:choice.model,...(choice.keychainRef?{keyEnv:ModelAccessEnvironment.secret}:{})};
  }
}

/**
 * Where cleanup's AI step gets its access. When the Mac app runs the companion (it sets
 * SCAN_TO_MAKE_MODEL_WORKER), the saved choice is read for every job and the step launches through the
 * app's signed helper. Headless setups and tests keep SCAN_TO_MAKE_AI_ACCESS and a direct worker.
 */
export function cleanupModelAccess(service:ModelAccessService|undefined,env:NodeJS.ProcessEnv,fromEnv:(env:NodeJS.ProcessEnv)=>ModelAccess){
  if (service && env.SCAN_TO_MAKE_MODEL_WORKER)
    return {access:()=>accessFromChoice(service.get().choice),worker:(args:string[],options:ModelWorkerOptions)=>service.run(args,options)};
  return {access:fromEnv(env)};
}

