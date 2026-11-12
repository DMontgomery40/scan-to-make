import {limitWords, type WorkerLimit} from '../touchup/runner.js';
import type {ObjectPass, StmObject} from './store.js';
import type {DesignEngine} from '../touchup/invocation.js';

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

/**
 * The last pass that worked on the model. A locate pass (docs/protocols/seats.md) only says where the scanned object
 * sits and changes nothing, so it is never "the last pass" for Retry, a failure or the session the next request continues.
 */
export function lastDesignPass(passes: ObjectPass[]): ObjectPass | undefined {
  return passes.filter(pass => pass.trigger !== 'locate').at(-1);
}

/**
 * The session the next request on this project continues, when its last pass ended in a way that allows it, with the
 * engine that session worked in: a pass that runs on another engine starts fresh instead (#609).
 */
export function passResume(pass: ObjectPass | undefined): {sessionId: string; passDir: string; sessionCwd?: string; engine?: DesignEngine} | undefined {
  if (!pass || pass.endedAtMs === undefined || pass.resumable !== true || !pass.sessionId || !pass.dir) return undefined;
  return {sessionId: pass.sessionId, passDir: pass.dir, ...(pass.sessionCwd ? {sessionCwd: pass.sessionCwd} : {}), ...(pass.engine ? {engine: pass.engine} : {})};
}

/**
 * Whether Retry belongs on this project: it failed because its last pass stopped, and that pass stopped at a limit or
 * can continue its session. `failedPass` names the pass whose ending is the project's failure; the store drops it
 * when anything else changes the failure (a later printer failure must not inherit Retry from an older worker stop).
 */
export function canRetryPass(object: Pick<StmObject, 'state' | 'failure' | 'failedPass' | 'passes'>): boolean {
  const last = lastDesignPass(object.passes);
  if (object.state !== 'failed' || !object.failure || !last || failedPass(object) !== last.startedAtMs) return false;
  return last.status === 'capped' || ((last.status === 'failed' || last.status === 'interrupted') && last.resumable === true && !!last.sessionId);
}

/**
 * The pass whose ending is the project's failure. A project saved before `failedPass` was recorded (Nov 10) says it
 * the old way: its last pass's last activity line is the failure sentence.
 */
export function failedPass(object: Pick<StmObject, 'state' | 'failure' | 'failedPass' | 'passes'>): number | undefined {
  if (object.failedPass !== undefined || object.state !== 'failed' || !object.failure) return object.failedPass;
  const last = lastDesignPass(object.passes);
  return last?.endedAtMs !== undefined && last.activity?.at(-1)?.text === object.failure ? last.startedAtMs : undefined;
}

/**
 * How an ended pass reads in a project's history, on every client (`passes[].words`); undefined while it runs. The
 * clients used to word the status themselves: the Mac matched spellings the companion never wrote and the phone and
 * Linux printed the raw status ("needs_closeup", "capped").
 */
export function passWords(pass: Pick<ObjectPass, 'endedAtMs' | 'status' | 'limit'>): string | undefined {
  if (pass.endedAtMs === undefined) return undefined;
  switch (pass.status) {
    case 'unchanged': return 'Nothing needed changing';
    // Any question, not only a close-up: this status also ends a pass that asked to confirm sizes or pick a part
    // (Nov 10: a size question read "Asked for a close-up" on real data).
    case 'needs_closeup': return 'Asked you a question';
    case 'needs_file': return "Asked for the designer's file";
    case 'capped': return pass.limit ? limitWords(pass.limit) : 'Stopped at a limit';
    case 'failed': return 'Stopped before it finished';
    case 'interrupted': return 'Stopped when Counterpart restarted';
    // `done`, and a pass from before statuses were kept.
    default: return 'Finished';
  }
}
