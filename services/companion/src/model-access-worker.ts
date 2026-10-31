import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ModelAccessChoiceSchema,type ModelAccessChoice} from './model-access-protocol.js';

export interface ModelWorkerResult {exitCode:number; stdout:string}
export interface ModelWorkerOptions {signal?:AbortSignal; timeoutMs?:number}
export type ModelWorker = (choice:ModelAccessChoice,args:string[],options:ModelWorkerOptions)=>Promise<ModelWorkerResult>;

/** The signed app alone resolves Keychain references and launches ai-tweak-cli.
 * No API credential enters the companion process or the helper's arguments. */
export function createBoundWorker(executable:string|undefined,flag:string,maxBytes=1024*1024) {
  return async (choice:unknown,args:string[],options:ModelWorkerOptions = {}):Promise<ModelWorkerResult> => {
    if (!executable || !isAbsolute(executable)) throw new Error('Model worker unavailable');
    options.signal?.throwIfAborted();
    // Reuse the bridge's allowlisted child environment pattern. Never inherit
    // printer tokens, provider keys or arbitrary operator environment variables.
    const env:NodeJS.ProcessEnv = {};
    if (flag === '--model-worker' && !('keychainRef' in (choice as object) && (choice as {keychainRef?:string}).keychainRef)) for (const key of ['HOME','PATH','TMPDIR','LANG','SCAN_TO_MAKE_CLAUDE_PATH','SCAN_TO_MAKE_CODEX_PATH','SCAN_TO_MAKE_SCAN_BLENDER','SCAN_TO_MAKE_CAPTURE_PYTHON']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (flag === '--model-worker' && ['claude-code','codex-cli'].includes((choice as {kind:string}).kind)) for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(executable,[flag,...args],{env,detached:true,stdio:['pipe','pipe','ignore']});
    let exceeded = false, bytes = 0, terminating = false;
    let settle:(code:number)=>void = () => {};
    const chunks:Buffer[] = [];
    let killTimer:NodeJS.Timeout|undefined;
    const terminate = () => {
      if (terminating || !child.pid) return;
      terminating = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',terminate);
      try { process.kill(-child.pid,'SIGTERM'); } catch { /* already gone */ }
      // ai-tweak gives its detached CLI descendants 3s to stop before KILL.
      // Keep the supervisor alive long enough to finish that cleanup.
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid!,'SIGKILL'); } catch { /* already gone */ }
        // A faulty descendant must not hold the response open past escalation.
        child.stdin.destroy(); child.stdout.destroy(); settle(1);
      },10000);
    };
    const timer = setTimeout(() => { exceeded = true; terminate(); },options.timeoutMs ?? 3900000);
    options.signal?.addEventListener('abort',terminate,{once:true});
    child.stdout.on('data',(chunk:Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { exceeded = true; terminate(); }
      else chunks.push(chunk);
    });
    child.stdin.on('error',() => {});
    const completion = new Promise<number>((resolve,reject) => {
      settle = resolve;
      child.once('error',() => reject(new Error('Model worker unavailable')));
      child.once('close',code => resolve(code ?? 1));
    });
    child.stdin.end(JSON.stringify(choice));
    if (options.signal?.aborted) terminate();
    try {
      const exitCode = await completion;
      options.signal?.throwIfAborted();
      if (exceeded) throw new Error('Model worker limit exceeded');
      return {exitCode,stdout:Buffer.concat(chunks).toString('utf8')};
    } finally {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort',terminate);
    }
  };
}

export function createModelWorker(executable:string|undefined):ModelWorker {
  const run = createBoundWorker(executable,'--model-worker');
  return async (choice,args,options) => {
    ModelAccessChoiceSchema.parse(choice);
    if (!['check','run'].includes(args[0] ?? '')) throw new Error('Model worker unavailable');
    return run(choice,args,options);
  };
}
