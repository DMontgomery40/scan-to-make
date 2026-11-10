import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {publicObject} from '../dist/objects/http.js';
import {carriedSeats, parseSeats, scanBoundsFromObj, scanFrameMatrix, seatMatrix, seatsProblem, stlBounds, transformPoint} from '../dist/objects/seats.js';
import {RULE_SECTIONS, systemRules, ruleSections, TOUCHUP_RESULT_SCHEMA} from '../dist/touchup/invocation.js';
import {tempDir} from './support/temp.mjs';

/** A closed box from `min` to `max`, as an ASCII STL. */
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid box\n${faces.map(f => `facet normal 0 0 0\nouter loop\n${f.map(i => `vertex ${v[i].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid box\n`;
}
// A holder 213 × 43 × 82 mm, and a bottle scan box 63 × 32 × 150 mm in the scan frame.
const HOLDER = box([0, 0, 0], [213, 43, 82]);
const BOTTLE = {min: [-31.5, -16, 0], max: [31.5, 16, 150]};
const SEATS = [{name: 'left', rotationDeg: [0, 0, 0], translationMm: [38, 22, 4]}, {name: 'middle', rotationDeg: [0, 0, 0], translationMm: [106.5, 22, 4]},
  {name: 'right', rotationDeg: [0, 0, 0], translationMm: [175, 22, 4]}];
const close = (a, b) => a.every((value, k) => Math.abs(value - b[k]) < 1e-9);

test('a seat is the transform cad_check_fit takes: turned about fixed X, then Y, then Z, then moved', () => {
  // 90° about X takes +Y to +Z; then 90° about Z takes +X to +Y; then the move.
  const m = seatMatrix({rotationDeg: [90, 0, 90], translationMm: [10, 20, 30]});
  assert.ok(close(transformPoint(m, [0, 1, 0]), [10, 20, 31]), 'Y turns to Z first, and Z is unchanged by the turn about Z');
  assert.ok(close(transformPoint(m, [1, 0, 0]), [10, 21, 30]), 'X turns to Y about the fixed Z axis');
  assert.ok(close(transformPoint(seatMatrix({rotationDeg: [0, 0, 0], translationMm: [1, 2, 3]}), [0, 0, 0]), [1, 2, 3]));
});

test("the scan frame is the scan's own coordinates in millimetres, turned Z up, never moved (load_scan with ground=False)", () => {
  const yUp = scanFrameMatrix(1, 'Y');
  assert.ok(close(transformPoint(yUp, [0.1, 0.2, 0.3]), [100, -300, 200]), '(x, y, z) metres becomes (x, -z, y) millimetres');
  assert.ok(close(transformPoint(scanFrameMatrix(0.001, 'z'), [1, 2, 3]), [1, 2, 3]), 'a Z-up millimetre scan is left as it is');
  assert.ok(close(transformPoint(scanFrameMatrix(1, 'x'), [1, 0, 0]), [0, 0, 1000]), '+X up turns to +Z');
  assert.equal(scanFrameMatrix(1, 'w'), undefined);
  const bounds = scanBoundsFromObj('# mesh\nv 0 0 0\nv 0.063 0.15 0.032\nvt 0 0\nf 1 2 1\n', 1, 'Y');
  assert.ok(close(bounds.min, [0, -32, 0]) && close(bounds.max, [63, 0, 150]), 'the OBJ box in the seat frame');
});

test('the worker\'s seats are kept only when every one is a well-formed placement', () => {
  assert.deepEqual(parseSeats(SEATS), SEATS);
  assert.deepEqual(parseSeats([{rotationDeg: [0, 0, 0], translationMm: [1, 2, 3], check: {minimumGapMm: 0.8, interferenceMm3: 0, clear: true, extra: 1}}]),
    [{rotationDeg: [0, 0, 0], translationMm: [1, 2, 3], check: {minimumGapMm: 0.8, interferenceMm3: 0, clear: true}}], 'the fit check\'s numbers ride along');
  assert.equal(parseSeats([]), undefined);
  assert.equal(parseSeats([{rotationDeg: [0, 0], translationMm: [1, 2, 3]}]), undefined, 'a malformed seat drops them all: never a partial set');
  assert.equal(parseSeats([{rotationDeg: [0, 0, 0], translationMm: [Infinity, 2, 3]}]), undefined);
  assert.equal(parseSeats('left'), undefined);
});

test('the companion refuses nonsense seats cheaply, with what it already has: no fit judgement', () => {
  const part = stlBounds(Buffer.from(HOLDER));
  assert.deepEqual(part, {min: [0, 0, 0], max: [213, 43, 82]});
  assert.equal(seatsProblem(SEATS, part, BOTTLE), undefined, 'three bottles in three pockets pass');
  assert.match(seatsProblem([SEATS[0], {...SEATS[0], name: 'again'}], part, BOTTLE), /are the same/);
  assert.match(seatsProblem([{name: 'far', rotationDeg: [0, 0, 0], translationMm: [1000, 0, 0]}], part, BOTTLE), /doesn.t touch the part/);
  assert.equal(seatsProblem([{rotationDeg: [0, 0, 0], translationMm: [1000, 0, 0]}], part, undefined), undefined, 'without the scan\'s box only sameness is checked');
  assert.deepEqual(carriedSeats(SEATS, undefined, true), SEATS, 'a pass that changed nothing keeps them');
  assert.equal(carriedSeats(SEATS, undefined, false), undefined, 'a changed model that restated none has none: never stale places');
});

test('a fit pass with a scan is told where the object sits and how to say it; a locate pass is told to change nothing', () => {
  assert.ok(ruleSections({kind: 'fit', scan: true}).includes('seats'));
  assert.ok(!ruleSections({kind: 'fit'}).includes('seats'), 'a fit from measurements alone has no seats');
  assert.ok(!ruleSections({kind: 'copy', scan: true}).includes('seats'));
  const code = systemRules({kind: 'fit', scan: true, engine: 'code'}, {cad: 'cad prompt'});
  assert.ok(code.includes(RULE_SECTIONS.seats));
  assert.match(code, /ground=False/);
  assert.match(code, /\(x, -z, y\)/);
  const locate = systemRules({kind: 'fit', scan: true, engine: 'code', locate: true}, {cad: 'cad prompt'});
  assert.match(locate, /never mark a cad_run final/);
  assert.match(locate, /write no STL or 3MF/);
  assert.ok(!locate.includes(RULE_SECTIONS.newDesign), 'a locate pass designs nothing');
  assert.deepEqual(TOUCHUP_RESULT_SCHEMA.properties.seats.items.required, ['rotationDeg', 'translationMm']);
});

/** A scripted worker that answers with the outcome given, writing a model unless told not to. */
async function setup(t, outcomes, {scanBox = BOTTLE} = {}) {
  const root = await tempDir('objects-seats-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), inputs = [];
  const runTouchup = async input => {
    inputs.push(input);
    const outcome = outcomes[inputs.length - 1];
    const passDir = join(root, `pass-${inputs.length}`), out = join(passDir, 'out');
    await mkdir(out, {recursive: true});
    const model = join(out, 'touched.stl');
    if (outcome.model !== false) await writeFile(model, HOLDER);
    return {renders: [], checkpoints: [], stats: {seconds: 3, toolCalls: 2}, passDir, ...(outcome.model !== false ? {model} : {}), status: outcome.status ?? 'done', ...outcome.result};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [213, 43, 82], claudePath: '/unused', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    events: {emit: async () => {}}, passTimings: new PassTimings(join(root, 'timings.json')), scanBounds: async () => scanBox});
  t.after(() => service.close());
  const object = await service.create('A wall holder for three of these', 'fit');
  await store.addFile(object.id, 'scan', 'scan.usdz', Buffer.from('usdz'));
  await store.update(object.id, o => ({...o, scan: 'scan.usdz'}));
  return {service, store, object, inputs};
}

test('a fit pass\'s seats are kept with its model, served to every client, and restated by a change', async t => {
  const f = await setup(t, [{result: {summary: 'Three pockets.', seats: SEATS}}, {result: {summary: 'Taller.', seats: SEATS.map(s => ({...s, translationMm: [s.translationMm[0], 22, 5]}))}}, {result: {summary: 'Thicker back.'}}]);
  await f.service.start(f.object.id);
  const ready = await f.service.settled(f.object.id);
  assert.deepEqual(ready.current.seats, SEATS);
  assert.deepEqual(publicObject(ready).current.seats, SEATS, 'phones and other computers read them from the project');
  await f.service.correct(f.object.id, 'Make it 1 mm taller');
  const taller = await f.service.settled(f.object.id);
  assert.deepEqual(f.inputs[1].seats, SEATS, 'the change is given the seats to restate');
  assert.equal(taller.current.seats[0].translationMm[2], 5, 'the restated seats replace the old ones');
  await f.service.correct(f.object.id, 'Make the back thicker');
  const thicker = await f.service.settled(f.object.id);
  assert.equal(thicker.current.seats, undefined, 'a changed model that restated none shows no Together view rather than a stale one');
});

test('nonsense seats are refused and said in the pass, and the model is kept', async t => {
  const f = await setup(t, [{result: {summary: 'Three pockets.', seats: [{name: 'far', rotationDeg: [0, 0, 0], translationMm: [5000, 0, 0]}]}}]);
  await f.service.start(f.object.id);
  const ready = await f.service.settled(f.object.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.current.seats, undefined);
  assert.match(ready.passes.at(-1).activity.at(-1).text, /didn’t keep where the object sits: The object placed at far doesn't touch the part/);
});

test('locate finds where the object sits in an existing part, changes nothing, and refuses an answer that comes with a model', async t => {
  const f = await setup(t, [{result: {summary: 'Three pockets.'}}, {model: false, result: {summary: 'One bottle in each pocket.', seats: SEATS}},
    {result: {summary: 'Rebuilt it.', seats: SEATS}}]);
  await f.service.start(f.object.id);
  const made = await f.service.settled(f.object.id);
  assert.equal(made.current.seats, undefined, 'made before passes said where the object sits');
  await f.store.update(f.object.id, o => ({...o, state: 'printed'}));
  const running = await f.service.locate(f.object.id);
  assert.equal(running.passes.at(-1).trigger, 'locate');
  const located = await f.service.settled(f.object.id);
  const dir = f.store.dir(f.object.id);
  assert.deepEqual(f.inputs[1].scan, [join(dir, 'current', 'model.stl'), join(dir, 'scan', 'scan.usdz')], 'the worker gets the finished part and the scan');
  assert.equal(f.inputs[1].locate, true);
  assert.equal(f.inputs[1].design, undefined);
  assert.equal(located.state, 'printed', 'the project goes back to where it was');
  assert.deepEqual(located.current.seats, SEATS);
  assert.equal(located.current.model, made.current.model);
  await f.store.update(f.object.id, o => ({...o, current: {...o.current, seats: undefined}}));
  await f.service.locate(f.object.id);
  const refused = await f.service.settled(f.object.id);
  assert.equal(refused.current.seats, undefined, 'an answer with a model is refused whole');
  assert.equal(refused.passes.at(-1).status, 'failed');
  assert.match(refused.passes.at(-1).activity.at(-1).text, /changed the model .* nothing from this pass was kept/);
  assert.equal(refused.state, 'printed');
});

test('locate is only for a part made to fit a scanned object', async t => {
  const f = await setup(t, []);
  await assert.rejects(f.service.locate(f.object.id), /made to fit a scanned object/, 'no model yet');
});

// Review of #451, blocker 1: See it together is the one pass that changes nothing. It gives back the open question,
// the failure and its Retry, and Marked Done, and it is never "the last pass" for Retry or the session a request resumes.
async function locatable(t, outcomes, shape) {
  const f = await setup(t, [{result: {summary: 'Three pockets.'}}, ...outcomes]);
  await f.service.start(f.object.id);
  await f.service.settled(f.object.id);
  await f.store.update(f.object.id, o => shape(o));
  return f;
}

test('locate leaves an open question exactly as it was', async t => {
  const ask = {id: 'ask-1', question: 'Can you take a close-up of the hook?', answers: ['camera', 'photos'], status: 'open', askedAtMs: 5};
  const f = await locatable(t, [{model: false, result: {summary: 'In the pockets.', seats: SEATS}}],
    o => ({...o, state: 'needs-closeup', question: {closeup: 'the hook'}, ask, pendingFollowup: 'Also round the edges', pendingMessageId: 'm-1'}));
  await f.service.locate(f.object.id);
  const after = await f.service.settled(f.object.id);
  assert.equal(after.state, 'needs-closeup');
  assert.deepEqual(after.question, {closeup: 'the hook'});
  assert.deepEqual(after.ask, ask);
  assert.equal(after.pendingFollowup, 'Also round the edges');
  assert.equal(after.pendingMessageId, 'm-1');
  assert.deepEqual(after.current.seats, SEATS, 'and its seats join the model');
});

test('locate leaves a failure and its Retry, and the next request still resumes the stopped pass', async t => {
  const failure = 'Stopped after 120 tool calls. Try again or review the saved checkpoint.';
  const f = await locatable(t, [{model: false, result: {summary: 'In the pockets.', seats: SEATS}}, {}], o => {
    const design = {...o.passes.at(-1), status: 'capped', resumable: true, sessionId: 'session-1', dir: '/tmp/pass-1', limit: {kind: 'tool-calls', value: 120},
      activity: [{atMs: 9, kind: 'message', text: failure}]};
    return {...o, state: 'failed', failure, failedPass: design.startedAtMs, passes: [...o.passes.slice(0, -1), design]};
  });
  assert.equal(publicObject(await f.service.get(f.object.id)).canRetryCleanup, true);
  await f.service.locate(f.object.id);
  const after = await f.service.settled(f.object.id);
  assert.equal(after.state, 'failed');
  assert.equal(after.failure, failure);
  assert.equal(publicObject(after).canRetryCleanup, true, 'Retry still belongs to the stopped design pass');
  assert.equal(after.passes.at(-1).trigger, 'locate');
  await f.service.correct(f.object.id, 'Try again with fewer steps');
  await f.service.settled(f.object.id);
  assert.equal(f.inputs.at(-1).resume?.sessionId, 'session-1', 'the next request continues the design pass, not the locate pass');
});

test('locate leaves Marked Done marked', async t => {
  const completion = {messageId: 'm-2', note: 'It works!', atMs: 7, previousStatus: 'printed'};
  const f = await locatable(t, [{model: false, result: {summary: 'In the pockets.', seats: SEATS}}],
    o => ({...o, state: 'confirmed', settings: {status: 'works'}, completion}));
  await f.service.locate(f.object.id);
  const after = await f.service.settled(f.object.id);
  assert.equal(after.state, 'confirmed');
  assert.deepEqual(after.completion, completion, 'never undone by a pass that changes nothing');
});

test('a refused or interrupted locate gives the project back too, a restart included', async t => {
  const failure = 'The printer stopped.';
  const f = await locatable(t, [{model: false, result: {summary: 'Rebuilt.', seats: SEATS}, status: 'failed'}], o => ({...o, state: 'failed', failure}));
  await f.service.locate(f.object.id);
  const refused = await f.service.settled(f.object.id);
  assert.equal(refused.state, 'failed');
  assert.equal(refused.failure, failure);
  // A restart in the middle of a locate pass: the project comes back as it was, not "interrupted".
  const started = Date.now();
  await f.store.update(f.object.id, o => ({...o, state: 'touching-up', failure: undefined,
    passes: [...o.passes, {startedAtMs: started, resumable: false, trigger: 'locate', before: {state: 'failed', failure}}]}));
  await f.store.recoverInterrupted();
  const restarted = await f.store.get(f.object.id);
  assert.equal(restarted.state, 'failed');
  assert.equal(restarted.failure, failure);
  assert.equal(restarted.passes.at(-1).status, 'interrupted');
});

test('locate is refused for a part that already has its seats', async t => {
  const f = await setup(t, [{result: {summary: 'Three pockets.', seats: SEATS}}]);
  await f.service.start(f.object.id);
  await f.service.settled(f.object.id);
  await assert.rejects(f.service.locate(f.object.id), /already knows where the object sits/);
});
