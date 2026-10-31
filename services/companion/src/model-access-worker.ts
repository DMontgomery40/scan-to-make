import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ModelAccessChoiceSchema,type ModelAccessChoice} from './model-access-protocol.js';

export interface ModelWorkerResult {exitCode:number; stdout:string}
export interface ModelWorkerOptions {signal?:AbortSignal; timeoutMs?:number;
  /** Cleanup jobs record the helper's process group so crash recovery can stop it (KAN-198). */
  onProcessGroup?:(pgid:number)=>void|Promise<void>}
export type ModelWorker = (choice:ModelAccessChoice,args:string[],options:ModelWorkerOptions)=>Promise<ModelWorkerResult>;

/** The signed app alone resolves Keychain references and launches ai-tweak-cli.
 * No API credential enters the companion process or the helper's arguments. */
export function createModelWorker(executable:string|undefined):ModelWorker {
  return async (choice,args,options) => {
    ModelAccessChoiceSchema.parse(choice);
    if (!executable || !isAbsolute(executable) || !['check','run'].includes(args[0] ?? '')) throw new Error('Model worker unavailable');
    options.signal?.throwIfAborted();
    // Reuse the bridge's allowlisted child environment pattern. Never inherit
    // printer tokens, provider keys or arbitrary operator environment variables.
    const env:NodeJS.ProcessEnv = {};
    if (!('keychainRef' in choice && choice.keychainRef)) for (const key of ['HOME','PATH','TMPDIR','LANG','SCAN_TO_MAKE_CLAUDE_PATH','SCAN_TO_MAKE_CODEX_PATH','SCAN_TO_MAKE_SCAN_BLENDER','SCAN_TO_MAKE_CAPTURE_PYTHON','SCAN_TO_MAKE_AI_JUDGE_TOOL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (choice.kind === 'claude-code' || choice.kind === 'codex-cli') for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(executable,['--model-worker',...args],{env,detached:true,stdio:['pipe','pipe','ignore']});
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
      if (bytes > 1024*1024) { exceeded = true; terminate(); }
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
      // Acknowledged before the worker's result counts; an unrecorded group is stopped, never orphaned.
      try { if (child.pid) await options.onProcessGroup?.(child.pid); } catch { exceeded = true; terminate(); }
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
