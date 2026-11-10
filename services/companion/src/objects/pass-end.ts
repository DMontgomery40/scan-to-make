import type {WorkerLimit} from '../touchup/runner.js';
import type {ObjectPass, StmObject} from './store.js';

/** How a design pass ended, as stored and as every client reads it (`passes[].status`). A pass with none is running. */
export const PASS_STATUSES = ['done', 'unchanged', 'needs_closeup', 'needs_file', 'capped', 'failed', 'interrupted'] as const;
export type PassStatus = typeof PASS_STATUSES[number];

/**
 * The ending of a pass. Only an ending that stopped short of an answer can say its worker's session may continue;
 * a finished answer or a question to the person never does (PRD §8.9: "Completed answers and person cancellation
 * never resume"). Before this type each of seven places closed a pass by hand, and one of them once left
 * `resumable` unset, so a finished conversation was continued (the Nov 9 train review, finding 2).
 */
export type PassEnd =
  | {status: 'done' | 'unchanged' | 'needs_closeup' | 'needs_file'}
  | {status: 'capped' | 'failed' | 'interrupted'; resumable: boolean; limit?: WorkerLimit};

/** What an ending may add to the pass's record beside its status. Never the fields `endPass` owns. */
export type PassEndDetails = Partial<Omit<ObjectPass, 'startedAtMs' | 'endedAtMs' | 'status' | 'resumable' | 'limit' | 'estimate' | 'stages'>>;

/**
 * Closes a pass: its end time and status, its open stage, no time-left estimate, and whether the next request may
 * continue its worker's session. `resumable` is true only for an ending that allows it and a pass that has a session.
 */
export function endPass(pass: ObjectPass, end: PassEnd, atMs: number, details: PassEndDetails = {}): ObjectPass {
  const {estimate: _estimate, limit: _limit, ...rest} = pass;
  const closed: ObjectPass = {...rest, ...details, endedAtMs: atMs, status: end.status,
    ...(rest.stages ? {stages: rest.stages.map(stage => stage.endedAtMs === undefined ? {...stage, endedAtMs: atMs} : stage)} : {})};
  return {...closed, resumable: 'resumable' in end && end.resumable && !!closed.sessionId,
    ...('limit' in end && end.limit ? {limit: end.limit} : {})};
}

/** The project's passes with the one started at `startedAtMs` closed. */
export function withPassEnded(passes: ObjectPass[], startedAtMs: number, end: PassEnd | ((pass: ObjectPass) => PassEnd), atMs: number, details?: PassEndDetails | ((pass: ObjectPass) => PassEndDetails)): ObjectPass[] {
  return passes.map(pass => pass.startedAtMs !== startedAtMs ? pass
    : endPass(pass, typeof end === 'function' ? end(pass) : end, atMs, typeof details === 'function' ? details(pass) : details));
}

/** The session the next request on this project continues, when its last pass ended in a way that allows it. */
export function passResume(pass: ObjectPass | undefined): {sessionId: string; passDir: string; sessionCwd?: string} | undefined {
  if (!pass || pass.endedAtMs === undefined || pass.resumable !== true || !pass.sessionId || !pass.dir) return undefined;
  return {sessionId: pass.sessionId, passDir: pass.dir, ...(pass.sessionCwd ? {sessionCwd: pass.sessionCwd} : {})};
}

/**
 * Whether Retry belongs on this project: it failed because its last pass stopped, and that pass stopped at a limit or
 * can continue its session. `failedPass` names the pass whose ending is the project's failure; the store drops it
 * when anything else changes the failure (a later printer failure must not inherit Retry from an older worker stop).
 */
export function canRetryPass(object: Pick<StmObject, 'state' | 'failure' | 'failedPass' | 'passes'>): boolean {
  const last = object.passes.at(-1);
  if (object.state !== 'failed' || !object.failure || !last || failedPass(object) !== last.startedAtMs) return false;
  return last.status === 'capped' || ((last.status === 'failed' || last.status === 'interrupted') && last.resumable === true && !!last.sessionId);
}

/**
 * The pass whose ending is the project's failure. A project saved before `failedPass` was recorded (Nov 10) says it
 * the old way: its last pass's last activity line is the failure sentence.
 */
export function failedPass(object: Pick<StmObject, 'state' | 'failure' | 'failedPass' | 'passes'>): number | undefined {
  if (object.failedPass !== undefined || object.state !== 'failed' || !object.failure) return object.failedPass;
  const last = object.passes.at(-1);
  return last?.endedAtMs !== undefined && last.activity?.at(-1)?.text === object.failure ? last.startedAtMs : undefined;
}
