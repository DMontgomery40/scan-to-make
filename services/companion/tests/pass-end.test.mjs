import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {endPass, withPassEnded, passResume, canRetryPass, passWords, PASS_STATUSES} from '../dist/objects/pass-end.js';
import {ObjectStore} from '../dist/objects/store.js';
import {publicObject} from '../dist/objects/http.js';
import {tempDir} from './support/temp.mjs';

const running = extra => ({startedAtMs: 10, stages: [{id: 'reading', startedAtMs: 10, endedAtMs: 12, typicalSec: 1}, {id: 'working', startedAtMs: 12, typicalSec: 5}],
  estimate: {remainingSec: 5, endsAtMs: 99}, ...extra});

test('every ending closes the pass the same way: end time, status, open stage, no estimate', () => {
  for (const status of PASS_STATUSES) {
    const end = ['capped', 'failed', 'interrupted'].includes(status) ? {status, resumable: false} : {status};
    const pass = endPass(running(), end, 50);
    assert.equal(pass.endedAtMs, 50, status);
    assert.equal(pass.status, status);
    assert.equal(pass.estimate, undefined, status);
    assert.deepEqual(pass.stages.map(stage => stage.endedAtMs), [12, 50], status);
    assert.equal(pass.resumable, false, status);
  }
});

test('only an ending that stopped short of an answer, on a pass with a session, may continue it', () => {
  for (const status of ['capped', 'failed', 'interrupted']) {
    assert.equal(endPass(running({sessionId: 's'}), {status, resumable: true}, 50).resumable, true, status);
    assert.equal(endPass(running(), {status, resumable: true}, 50).resumable, false, `${status}: no session, nothing to continue`);
    assert.equal(endPass(running({sessionId: 's', resumable: true}), {status, resumable: false}, 50).resumable, false, `${status}: the ending decides, not what the running pass said`);
    // The session can arrive with the ending itself.
    assert.equal(endPass(running(), {status, resumable: true}, 50, {sessionId: 'late'}).resumable, true, status);
  }
  // An answer or a question never continues, whatever the running pass recorded (the Nov 9 train review, finding 2).
  for (const status of ['done', 'unchanged', 'needs_closeup', 'needs_file'])
    assert.equal(endPass(running({sessionId: 's', resumable: true}), {status}, 50).resumable, false, status);
});

test('a limit is kept with the ending that names it and never left over from the running pass', () => {
  const limit = {kind: 'inactivity', value: 600000};
  assert.deepEqual(endPass(running(), {status: 'capped', resumable: false, limit}, 50).limit, limit);
  assert.deepEqual(endPass(running(), {status: 'failed', resumable: false, limit}, 50).limit, limit);
  assert.equal(endPass(running({limit}), {status: 'done'}, 50).limit, undefined);
});

test('the next request continues a session only from an ended, resumable pass with its folder', () => {
  const ended = endPass(running({sessionId: 's', sessionCwd: '/w', dir: '/p'}), {status: 'capped', resumable: true}, 50);
  assert.deepEqual(passResume(ended), {sessionId: 's', passDir: '/p', sessionCwd: '/w'});
  assert.equal(passResume(running({sessionId: 's', dir: '/p', resumable: true})), undefined, 'still running');
  assert.equal(passResume({...ended, dir: undefined}), undefined);
  assert.equal(passResume(endPass(running({sessionId: 's', dir: '/p'}), {status: 'done'}, 50)), undefined);
  assert.equal(passResume(undefined), undefined);
});

test('only the named pass is closed', () => {
  const passes = withPassEnded([{startedAtMs: 1, endedAtMs: 2, status: 'done'}, running()], 10, {status: 'done'}, 50, pass => ({summary: `from ${pass.startedAtMs}`}));
  assert.deepEqual(passes[0], {startedAtMs: 1, endedAtMs: 2, status: 'done'});
  assert.equal(passes[1].summary, 'from 10');
});

test('Retry belongs to the pass that failed the project, and to nothing that fails it afterwards', async t => {
  const root = await tempDir('pass-end-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = new ObjectStore(join(root, 'objects'));
  const object = await store.create('A bracket', 'fit');
  const stopped = await store.update(object.id, o => ({...o, state: 'failed', failure: 'Stopped after 10 minutes without activity. Try again.', failedPass: 10,
    passes: [endPass(running({sessionId: 's', dir: '/p'}), {status: 'capped', resumable: true}, 50)]}));
  assert.equal(canRetryPass(stopped), true);
  assert.equal(publicObject(stopped).canRetryCleanup, true);
  assert.equal('failedPass' in publicObject(stopped), false, 'local bookkeeping stays off the wire');
  // An unrelated change keeps it.
  assert.equal((await store.update(object.id, o => ({...o, title: 'Bracket'}))).failedPass, 10);
  // The failure sentence is no longer compared with the activity log: trimming or rewording either changes nothing.
  assert.equal(canRetryPass({...stopped, passes: stopped.passes.map(pass => ({...pass, activity: [{atMs: 1, kind: 'message', text: 'something else'}]}))}), true);
  // A later printer failure, written by code that knows nothing of passes, does not inherit Retry.
  const printer = await store.update(object.id, o => ({...o, state: 'failed', failure: 'The printer reported a failure.'}));
  assert.equal(printer.failedPass, undefined);
  assert.equal(publicObject(printer).canRetryCleanup, false);
  // Leaving failed loses it too, so a later failure with the same words can't pick it up again.
  const again = await store.update(object.id, o => ({...o, state: 'failed', failure: stopped.failure, failedPass: 10}));
  assert.equal((await store.update(again.id, o => ({...o, state: 'ready', failure: undefined}))).failedPass, undefined);
  // A failed pass that can't continue offers no Retry; a newer pass makes an older failure's Retry stale.
  assert.equal(canRetryPass({...stopped, passes: [endPass(running({sessionId: 's'}), {status: 'failed', resumable: false}, 50)]}), false);
  assert.equal(canRetryPass({...stopped, passes: [...stopped.passes, {startedAtMs: 60}]}), false);
});

test('a project failed before the owner was recorded still offers Retry, told the old way', () => {
  const failure = 'Stopped at the 120 tool-call limit. Try again.';
  const legacy = {state: 'failed', failure, passes: [{startedAtMs: 10, endedAtMs: 50, status: 'capped', activity: [{atMs: 50, kind: 'message', text: failure}]}]};
  assert.equal(canRetryPass(legacy), true);
  assert.equal(canRetryPass({...legacy, failure: 'The printer reported a failure.'}), false);
});

test('every ending has words, sent to every client with the pass, and a running pass has none', () => {
  assert.equal(passWords(running()), undefined);
  const words = Object.fromEntries(PASS_STATUSES.map(status => [status, passWords({endedAtMs: 50, status})]));
  assert.deepEqual(words, {done: 'Finished', unchanged: 'Nothing needed changing', needs_closeup: 'Asked you a question', needs_file: "Asked for the designer's file",
    capped: 'Stopped at a limit', failed: 'Stopped before it finished', interrupted: 'Stopped when Counterpart restarted'});
  // A limit says which one, in the words the failure uses.
  assert.equal(passWords({endedAtMs: 50, status: 'capped', limit: {kind: 'tool-calls', value: 120}}), 'Stopped at the 120 tool-call limit');
  assert.equal(passWords({endedAtMs: 50}), 'Finished', 'a pass from before statuses were kept');
  for (const said of Object.values(words)) assert.doesNotMatch(said, /_|needs-|capped/, 'never the wire spelling');
  const shown = publicObject({id: 'p', createdAtMs: 1, updatedAtMs: 2, state: 'ready', photos: [], requestPhotos: [], pendingPhotos: [], messages: [],
    passes: [endPass(running(), {status: 'needs_closeup'}, 50), running()]});
  assert.deepEqual(shown.passes.map(pass => pass.words), ['Asked you a question', undefined]);
});
