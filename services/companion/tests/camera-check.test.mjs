import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PrinterMcpError} from '@scan-to-make/printer-handoff';
import {checkPrintFrame, claudeVisionJudge, visionAnswer, visionPrompt} from '../dist/printing/camera-check.js';
import {PrintMonitorRunner, milestonesFor} from '../dist/printing/monitor.js';
import {eventWords, objectStatus, printLogLine, NOTIFY} from '../dist/events/words.js';

/**
 * #630, the client half: David's P1S printed air (print faf29c4d) while Counterpart said "first layer's down" with this
 * empty-plate frame attached. These tests replay his two real camera frames through a fake printer MCP that speaks
 * counterpart/1's record/assess tools (no printer), with the vision worker's answer scripted per image.
 */
const fixture = name => readFileSync(new URL(`./fixtures/camera-check/${name}`, import.meta.url));
const EMPTY = fixture('empty-first-layer.jpg'), PRINTING = fixture('printing.jpg');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ARTIFACT = 'dcc9b3260dd0c33e45b8f6711b9899ec8cf2b0d90278b76b029fff2f2bb03640';
const FOOTPRINT = [10.622, 71.348, 245.402, 180.628];

/** A printer MCP's counterpart_print_record / counterpart_print_assess, from disk only, as both MCPs implement them. */
function fakeMcp({frames, tools = ['counterpart_print_record', 'counterpart_print_assess'], jobId = randomUUID()} = {}) {
  const calls = [], observations = [];
  const verdict = () => {
    const o = observations.at(-1);
    if (o && o.visibility === 'clear' && o.footprint_visible && o.deposition === 'absent' && o.attempted)
      return {status: 'suspect_no_extrusion', evidence: [o.frame_id], limitations: []};
    return {status: 'unknown', evidence: [], limitations: []};
  };
  const session = {
    backend: 'bambu-printer-mcp',
    config: {backend: 'bambu-printer-mcp', process: {command: 'bambu-printer-mcp'}},
    hasTool: name => tools.includes(name),
    getTool: name => ({name, inputSchema: {type: 'object', properties: name === 'counterpart_print_record'
      ? {frame_format: {}, frame_ids: {}, job_id: {}, host: {}, bambu_serial: {}}
      : {job_id: {}, artifact_sha256: {}, frame_id: {}, image_sha256: {}, visibility: {}, footprint_visible: {}, deposition: {}, attempted: {},
        reference_frame_id: {}, reference_visibility: {}, reference_empty: {}, host: {}, bambu_serial: {}}}}),
    async connect() {},
    async call(name, args) {
      calls.push({name, args});
      if (name === 'counterpart_print_record') {
        if (args.frame_ids.some(id => !frames.some(f => f.id === id))) {
          throw new PrinterMcpError('tool-failed', undefined, 'Requested frame is not part of this job (at most four).');
        }
        const content = [{type: 'text', text: ''}];
        const listed = frames.filter(f => args.frame_ids.includes(f.id)).map(({jpeg, ...meta}) => {
          if (!jpeg) return meta;
          content.push({type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg'});
          return {...meta, imageContentIndex: content.length - 1};
        });
        const structuredContent = {contract: 'counterpart/1', status: 'recorded', record: {id: jobId, dispatch: {sha256: ARTIFACT}, frames: listed}, physical: verdict()};
        content[0].text = JSON.stringify(structuredContent);
        return {content, structuredContent};
      }
      if (name === 'counterpart_print_assess') {
        observations.push(args);
        const structuredContent = {contract: 'counterpart/1', status: 'recorded', physical: verdict()};
        return {content: [{type: 'text', text: JSON.stringify(structuredContent)}], structuredContent};
      }
      throw new Error(`the camera check must not call ${name}`);
    },
  };
  return {session, calls, observations, jobId, verdict};
}

const savedFrame = (jpeg, extra = {}) => ({id: randomUUID(), role: 'first_layer', layer: 1, status: 'captured', sha256: sha(jpeg), expectedHeightMm: 0.2,
  capturedAt: '2026-11-11T19:21:42.000Z', reportAt: '2026-11-11T19:21:40.000Z', jpeg, ...extra});
const assessmentFor = (frame, references = []) => ({required: true, frameId: frame.id, referenceFrameIds: references.map(r => r.id), layer: frame.layer,
  expectedHeightMm: 0.2, expectedFootprintMm: FOOTPRINT});

/** The vision worker, scripted per picture: what a person sees in David's two frames. It records what it was shown. */
function scriptedJudge(answers) {
  const seen = [];
  const judge = async ({dir, prompt, reference}) => {
    const bytes = await readFile(join(dir, 'frame.jpg'));
    seen.push({sha: sha(bytes), prompt, reference, referenceFile: existsSync(join(dir, 'reference.jpg'))});
    return answers[sha(bytes)];
  };
  return {judge, seen};
}
// Opus 5.5's own answers on these two frames with this prompt (Nov 12 calibration run, PR description).
const EMPTY_PLATE = {seen: 'The dark, textured plate is in view across the middle and looks bare: only scratches and sparkle, no lines, filled areas or raised parts.',
  visibility: 'clear', footprintVisible: true, deposition: 'absent'};
const PLASTIC = {seen: 'Grey printed parts stand on the plate in the middle of the picture.', visibility: 'clear', footprintVisible: true, deposition: 'present'};

test('the empty-plate first-layer frame from print faf29c4d is judged and submitted bound to its job, artifact and image hashes', async () => {
  const frame = savedFrame(EMPTY);
  const mcp = fakeMcp({frames: [frame]});
  const {judge, seen} = scriptedJudge({[sha(EMPTY)]: EMPTY_PLATE});
  const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), judge, new AbortController().signal);
  assert.deepEqual(mcp.calls.map(c => c.name), ['counterpart_print_record', 'counterpart_print_assess'], 'reads the record and submits; nothing else');
  assert.deepEqual(mcp.calls[0].args, {frame_format: 'images', frame_ids: [frame.id]});
  assert.deepEqual(mcp.observations[0], {job_id: mcp.jobId, artifact_sha256: ARTIFACT, frame_id: frame.id, image_sha256: sha(EMPTY),
    visibility: 'clear', footprint_visible: true, deposition: 'absent', attempted: true});
  assert.equal(seen[0].sha, sha(EMPTY), 'the worker was shown exactly the saved frame');
  assert.match(seen[0].prompt, /layer 1, about 0\.2 mm above the plate/);
  assert.match(seen[0].prompt, /X 11–245 mm and Y 71–181 mm of the build plate, an area about 235 × 109 mm/);
  assert.equal(outcome.deposition, 'absent');
  assert.equal(outcome.firstLayer, true);
  assert.equal(outcome.physical.status, 'suspect_no_extrusion');
  assert.deepEqual(outcome.jpeg, EMPTY);
});

test('a normal printing frame is submitted as plastic present, and the MCP verdict stays unknown', async () => {
  const frame = savedFrame(PRINTING, {role: 'periodic', layer: 120});
  const mcp = fakeMcp({frames: [frame]});
  const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), scriptedJudge({[sha(PRINTING)]: PLASTIC}).judge, new AbortController().signal);
  assert.equal(mcp.observations[0].deposition, 'present');
  assert.equal(outcome.deposition, 'present');
  assert.equal(outcome.firstLayer, false);
  assert.equal(outcome.physical.status, 'unknown');
});

test('uncertain stays unknown: a dark, occluded, out-of-view or unlocatable footprint is never submitted as absent or present', async () => {
  for (const answer of [{visibility: 'dark', footprintVisible: true, deposition: 'absent'}, {visibility: 'occluded', footprintVisible: true, deposition: 'present'},
    {visibility: 'out_of_view', footprintVisible: false, deposition: 'absent'}, {visibility: 'clear', footprintVisible: false, deposition: 'absent'}]) {
    const frame = savedFrame(EMPTY);
    const mcp = fakeMcp({frames: [frame]});
    const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), scriptedJudge({[sha(EMPTY)]: answer}).judge, new AbortController().signal);
    assert.equal(mcp.observations[0].deposition, 'unknown', JSON.stringify(answer));
    assert.equal(mcp.observations[0].visibility, answer.visibility);
    assert.equal(outcome.physical.status, 'unknown');
  }
  assert.equal(visionAnswer({visibility: 'clear', footprintVisible: true, deposition: 'maybe'}), undefined);
  assert.equal(visionAnswer(undefined), undefined);
});

test('an empty-plate reference from before printing goes with the frame, and its own visibility is passed on', async () => {
  const baseline = savedFrame(EMPTY, {role: 'baseline', layer: 0}), frame = savedFrame(EMPTY);
  const mcp = fakeMcp({frames: [baseline, frame]});
  const {judge, seen} = scriptedJudge({[sha(EMPTY)]: {...EMPTY_PLATE, referenceVisibility: 'out_of_view', referenceEmpty: true}});
  await checkPrintFrame(mcp.session, assessmentFor(frame, [baseline]), judge, new AbortController().signal);
  assert.deepEqual(mcp.calls[0].args.frame_ids, [frame.id, baseline.id]);
  assert.equal(seen[0].referenceFile, true);
  assert.match(seen[0].prompt, /reference\.jpg was taken before printing started/);
  // Out of view is not "empty": only a clear reference can say the plate was empty.
  assert.deepEqual([mcp.observations[0].reference_frame_id, mcp.observations[0].reference_visibility, mcp.observations[0].reference_empty], [baseline.id, 'out_of_view', false]);
});

test('nothing is judged or submitted without a frame whose bytes match its saved hash, or without the contract tools', async () => {
  const never = async () => { throw new Error('the worker must not run'); };
  const changed = savedFrame(EMPTY, {sha256: sha(PRINTING)});
  const a = fakeMcp({frames: [changed]});
  assert.equal(await checkPrintFrame(a.session, assessmentFor(changed), never, new AbortController().signal), undefined);
  const baseline = savedFrame(EMPTY, {role: 'baseline', layer: 0});
  const b = fakeMcp({frames: [baseline]});
  assert.equal(await checkPrintFrame(b.session, assessmentFor(baseline), never, new AbortController().signal), undefined);
  const stale = savedFrame(EMPTY);
  const c = fakeMcp({frames: [savedFrame(PRINTING)]});
  assert.equal(await checkPrintFrame(c.session, assessmentFor(stale), never, new AbortController().signal), undefined, 'a frame of an earlier job');
  const old = fakeMcp({frames: [stale], tools: []});
  assert.equal(await checkPrintFrame(old.session, assessmentFor(stale), never, new AbortController().signal), undefined, 'an MCP without counterpart_print_record');
  for (const mcp of [a, b, c]) assert.equal(mcp.observations.length, 0);
});

test('a model that gives no usable answer is submitted as unknown, so the MCP can ask about its later checkpoints; a stopped check says nothing', async () => {
  for (const judge of [async () => ({nonsense: true}), async () => { throw new Error('worker timed out'); }]) {
    const frame = savedFrame(EMPTY);
    const mcp = fakeMcp({frames: [frame]});
    const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), judge, new AbortController().signal);
    assert.deepEqual([mcp.observations[0].visibility, mcp.observations[0].footprint_visible, mcp.observations[0].deposition], ['unknown', false, 'unknown']);
    assert.equal(outcome.deposition, 'unknown');
  }
  const frame = savedFrame(EMPTY);
  const mcp = fakeMcp({frames: [frame]});
  const controller = new AbortController();
  await assert.rejects(checkPrintFrame(mcp.session, assessmentFor(frame), async () => { controller.abort(); return undefined; }, controller.signal));
  assert.equal(mcp.observations.length, 0);
});

test("the vision worker is the person's Claude login with the Read tool only: no printer MCP, no other tools", async () => {
  let invocation, options;
  const worker = async (inv, opts) => { invocation = inv; options = opts; return {exitCode: 0, resultEvent: {structured_output: EMPTY_PLATE}, toolCalls: 1, seconds: 1, stderrTail: '', publicText: t => t}; };
  const frame = savedFrame(EMPTY);
  const mcp = fakeMcp({frames: [frame]});
  const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), claudeVisionJudge(worker), new AbortController().signal);
  assert.equal(outcome.deposition, 'absent');
  assert.deepEqual(invocation.mcpConfig, {mcpServers: {}});
  const flag = name => invocation.args[invocation.args.indexOf(name) + 1];
  assert.equal(flag('--model'), 'claude-opus-5-5');
  assert.equal(flag('--tools'), 'Read');
  assert.equal(flag('--allowedTools'), 'Read');
  assert.equal(flag('--setting-sources'), '');
  assert.ok(invocation.args.includes('--strict-mcp-config'));
  assert.ok(options.timeoutMs <= 150_000 && options.maxToolCalls <= 6);
  assert.equal(existsSync(invocation.cwd), false, 'the private folder with the pictures is removed afterwards');
  assert.match(visionPrompt(assessmentFor(frame), false), /"unknown" if you are not sure/);
  assert.doesNotMatch(visionPrompt(assessmentFor(frame), false), /reference\.jpg/);
});

// ---------------------------------------------------------------------------
// The monitor with the check: David's two prints, replayed.

const T0 = Date.parse('2026-11-11T19:01:00.000Z');
const JOB = 'checked-1b2c3d4e-0000-4000-8000-000000000000-Forester';
function watch({frames, answers, reports, milestones = '50'}) {
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const mcp = fakeMcp({frames});
  const {judge} = scriptedJudge(answers);
  const events = [], kept = new Map(), saves = [];
  let queue = [...reports];
  const read = async () => {
    const next = typeof queue[0] === 'function' ? queue.shift()(mcp) : queue.shift();
    if (!next) throw new Error('script ran out');
    return {observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...next};
  };
  const target = {projectId: randomUUID(), printId: randomUUID(), destinationId: 'current', printerName: 'Bambu Lab P1S', jobName: JOB, dispatchedAtMs: T0};
  const monitor = new PrintMonitorRunner(target, {clock, read, milestones: () => milestonesFor(milestones),
    frame: async id => `prints/${target.printId}/frames/${id}.jpg`,
    keepFrame: async (id, jpeg) => { kept.set(id, jpeg); return `prints/${target.printId}/frames/${id}.jpg`; },
    check: (assessment, signal) => checkPrintFrame(mcp.session, assessment, judge, signal),
    save: async (m, live) => { saves.push({m, live}); }, end: async () => {}, emit: async draft => { events.push(draft); }});
  const signal = new AbortController().signal;
  return {mcp, events, kept, saves, monitor, types: () => events.map(e => e.type),
    async step() { await monitor.step(signal); await monitor.checked(); clock.t += 10_000; }};
}
const running = (layer, extra = {}) => ({state: 'printing', job: {name: JOB, progress: Math.min(99, layer / 2.65), layer, totalLayers: 265, remainingSec: 5000}, ...extra});
/** The MCP's progress: its verdict so far, and the first-layer frame it asks about until an observation is saved. */
const physicalNow = frame => mcp => {
  const verdict = mcp.verdict();
  const asked = !mcp.observations.length ? {assessment: assessmentFor(frame)} : {};
  const problems = verdict.status === 'suspect_no_extrusion'
    ? [{code: 'physical-no-extrusion', severity: 'error', message: 'Possible extrusion failure: the expected print area appeared empty. Check the print.'}] : [];
  return {physical: {...verdict, ...asked}, problems};
};

test('P0 replay of faf29c4d: an empty first layer is never "first layer\'s down"; the MCP\'s verdict is one time-sensitive check in its own words, with the empty frame, on the card, and "done" says so', async () => {
  const frame = savedFrame(EMPTY);
  const now = physicalNow(frame);
  const h = watch({frames: [frame], answers: {[sha(EMPTY)]: EMPTY_PLATE}, reports: [
    running(0, {state: 'preparing'}),
    mcp => running(1, now(mcp)),
    mcp => running(2, now(mcp)),
    mcp => running(20, now(mcp)),
    mcp => running(140, now(mcp)),
    mcp => ({state: 'finished', job: {name: JOB, progress: 100, layer: 265, totalLayers: 265}, ...now(mcp)}),
  ]});
  for (let i = 0; i < 6; i++) await h.step();
  assert.equal(h.types().includes('print.first-layer'), false, 'the empty frame never says the first layer is down');
  assert.equal(h.types().filter(t => t === 'print.check').length, 1, 'said once');
  assert.equal(h.types().includes('print.milestone'), false, '"halfway" is not news after the camera showed nothing coming out');
  const check = h.events.find(e => e.type === 'print.check');
  assert.deepEqual(h.kept.get(check.id), EMPTY, 'the frame attached is the judged one');
  // The MCP's own problem, as it sent it: keyed on physical.status, never on its code or wording, and not rewritten.
  const line = 'Possible extrusion failure: the expected print area appeared empty. Check the print.';
  assert.deepEqual(check.data.problems, [{code: 'physical-no-extrusion', message: line}]);
  const words = eventWords('print.check', check.data, {title: 'Forester', printer: 'Bambu Lab P1S'});
  assert.deepEqual(words, {title: 'Check Forester on Bambu Lab P1S', body: line, notify: 'timeSensitive'});
  assert.equal(NOTIFY['print.check'], 'timeSensitive');
  // The card: the live report and the status line every layout shows.
  const live = h.saves.findLast(s => s.live?.state === 'printing').live;
  assert.equal(live.problems[0].message, line);
  const monitor = h.saves.findLast(s => s.live?.state === 'printing').m;
  assert.equal(monitor.checkSent, true);
  const status = objectStatus({state: 'printing', print: {dispatchedAt: new Date(T0).toISOString(), destination: {name: 'Bambu Lab P1S'}, monitor, live}});
  assert.deepEqual([status.phase, status.text, status.tint], ['printing', line, 'orange']);
  // Without the structured verdict the same problem is just a problem: the line isn't taken over.
  const plain = objectStatus({state: 'printing', print: {dispatchedAt: new Date(T0).toISOString(), destination: {name: 'Bambu Lab P1S'}, monitor: {...monitor, checkSent: undefined}, live}});
  assert.match(plain.text, /^Printing on Bambu Lab P1S/);
  // Firmware FINISH is not a part on the plate.
  const done = h.events.find(e => e.type === 'print.done');
  assert.equal(done.detail.reason, line);
  assert.deepEqual(eventWords('print.done', done.data, {title: 'Forester', printer: 'Bambu Lab P1S', reason: done.detail.reason}),
    {title: 'Bambu Lab P1S says Forester is done', body: line, notify: 'active'});
  assert.equal(printLogLine('print.done', done.data, done.detail.reason), `The printer says it's done. ${line}`);
  assert.equal(printLogLine('print.check', check.data), line);
  assert.equal(h.monitor.state.checkSent, true);
  // Never a control: only the record and the observation.
  assert.deepEqual([...new Set(h.mcp.calls.map(c => c.name))], ['counterpart_print_record', 'counterpart_print_assess']);
});

test('a healthy first layer is "first layer\'s down" only after the camera shows plastic, with that frame', async () => {
  const frame = savedFrame(PRINTING);
  const now = physicalNow(frame);
  const h = watch({frames: [frame], answers: {[sha(PRINTING)]: PLASTIC}, reports: [
    mcp => running(1, now(mcp)), mcp => running(2, now(mcp)), mcp => running(3, now(mcp)),
  ]});
  await h.step();
  assert.equal(h.types().includes('print.first-layer'), false, 'not before the check has answered');
  await h.step();
  const first = h.events.filter(e => e.type === 'print.first-layer');
  assert.equal(first.length, 1);
  assert.deepEqual(h.kept.get(first[0].id), PRINTING);
  assert.equal(h.types().includes('print.check'), false);
  await h.step();
  assert.equal(h.events.filter(e => e.type === 'print.first-layer').length, 1);
  assert.equal(h.monitor.state.firstLayerSent, true);
});

test('with no camera check (AI off, or an MCP without the contract) there is no first-layer claim at all', async () => {
  const frame = savedFrame(EMPTY);
  const h = watch({frames: [frame], answers: {}, reports: [running(1, {physical: {status: 'unknown', evidence: [], assessment: assessmentFor(frame)}}), running(2), running(3)]});
  for (let i = 0; i < 3; i++) await h.step();
  assert.equal(h.types().includes('print.first-layer'), false);
  assert.equal(h.types().includes('print.check'), false);
  assert.deepEqual(h.mcp.observations.map(o => o.deposition), ['unknown'], 'a check with no answer says unknown, once');
});

test('P0 replay, the calibrated case: the first layer is unclear, the ten-layer checkpoint shows the plate still empty, and that is the check', async () => {
  const first = savedFrame(EMPTY), later = savedFrame(EMPTY, {role: 'periodic', layer: 11, expectedHeightMm: 2.2});
  // Opus 5.5 on this frame at layer 1: unknown twice in three runs; at layer 11: absent every time.
  const now = mcp => {
    const verdict = mcp.verdict();
    const observed = new Set(mcp.observations.map(o => o.frame_id));
    const pending = [first, ...(mcp.observations.length ? [later] : [])].find(f => !observed.has(f.id));
    return {physical: {...verdict, ...(pending ? {assessment: {...assessmentFor(pending), layer: pending.layer, expectedHeightMm: pending.expectedHeightMm}} : {})},
      problems: verdict.status === 'suspect_no_extrusion' ? [{code: 'physical-no-extrusion', severity: 'error', message: 'Possible extrusion failure.'}] : []};
  };
  const judge = async ({prompt}) => /layer 1,/.test(prompt) ? {seen: 'A darker area might be a dark first layer.', visibility: 'clear', footprintVisible: true, deposition: 'unknown'} : EMPTY_PLATE;
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const mcp = fakeMcp({frames: [first, later]});
  const events = [], kept = new Map();
  const reports = [m => running(1, now(m)), m => running(11, now(m)), m => running(12, now(m)), m => running(13, now(m))];
  const monitor = new PrintMonitorRunner({projectId: randomUUID(), printId: randomUUID(), destinationId: 'current', printerName: 'Bambu Lab P1S', jobName: JOB, dispatchedAtMs: T0}, {
    clock, read: async () => ({observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...reports.shift()(mcp)}), milestones: () => [],
    keepFrame: async (id, jpeg) => { kept.set(id, jpeg); return `prints/x/frames/${id}.jpg`; }, check: (a, s) => checkPrintFrame(mcp.session, a, judge, s),
    save: async () => {}, end: async () => {}, emit: async draft => { events.push(draft); }});
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++) { await monitor.step(signal); await monitor.checked(); clock.t += 10_000; }
  assert.deepEqual(mcp.observations.map(o => [o.frame_id, o.deposition]), [[first.id, 'unknown'], [later.id, 'absent']]);
  const check = events.filter(e => e.type === 'print.check');
  assert.equal(check.length, 1);
  assert.equal(check[0].data.problems[0].message, 'Possible extrusion failure.');
  assert.equal(events.some(e => e.type === 'print.first-layer'), false);
});

test("an MCP's verdict from another client's observation still raises the check once, without a frame of its own", async () => {
  const h = watch({frames: [], answers: {}, reports: [
    running(5, {physical: {status: 'suspect_no_extrusion', evidence: [randomUUID()]}, problems: [{code: 'physical-no-extrusion', severity: 'error', message: 'Possible extrusion failure.'}]}),
    running(6, {physical: {status: 'suspect_no_extrusion', evidence: []}}),
  ]});
  await h.step(); await h.step();
  assert.equal(h.types().filter(t => t === 'print.check').length, 1);
  const check = h.events.find(e => e.type === 'print.check');
  assert.equal(h.kept.has(check.id), false);
  assert.match(check.frame, /^prints\/.+\.jpg$/, 'a fresh camera frame instead');
  assert.equal(check.data.problems[0].message, 'Possible extrusion failure.');
});

test('the shared print.check fixture every client decodes is exactly what the companion says (packages/contracts/fixtures/print-check.json)', async () => {
  const {CounterpartEventSchema, PrintLiveSchema, PrintMonitorSchema, ObjectStatusSchema} = await import('@scan-to-make/contracts/counterpart');
  const shared = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/print-check.json', import.meta.url), 'utf8'));
  const event = CounterpartEventSchema.parse(shared.event);
  assert.equal(event.type, 'print.check');
  assert.deepEqual(eventWords('print.check', event.data, {title: 'Forester', printer: event.printerName}), {title: event.title, body: event.body, notify: event.notify});
  assert.equal(event.body, shared.line);
  PrintMonitorSchema.parse(shared.project.print.monitor);
  const live = PrintLiveSchema.parse(shared.project.print.live);
  assert.equal(live.problems[0].message, shared.line);
  // The status line is the one field every layout's print card shows (iPhone/iPad and Mac: status.text; Android: Words.kt; Linux: words()).
  assert.deepEqual(ObjectStatusSchema.parse(shared.project.status), objectStatus(shared.project));
  assert.equal(shared.project.status.text, shared.line);
  assert.equal(shared.project.print.events[0].message, printLogLine('print.check', event.data));
});

test('a check that fails on the way (the session reconnecting) is tried again, so the later checkpoint still gets its look', async () => {
  const first = savedFrame(EMPTY), later = savedFrame(EMPTY, {role: 'periodic', layer: 11, expectedHeightMm: 2.2});
  const mcp = fakeMcp({frames: [first, later]});
  const call = mcp.session.call.bind(mcp.session);
  let failures = 1;
  mcp.session.call = async (name, args) => {
    if (name === 'counterpart_print_record' && failures-- > 0) throw new PrinterMcpError('printer-unreachable');
    return call(name, args);
  };
  const now = m => {
    const observed = new Set(m.observations.map(o => o.frame_id));
    const pending = [first, later].find(f => !observed.has(f.id));
    const verdict = m.verdict();
    return {physical: {...verdict, ...(pending ? {assessment: {...assessmentFor(pending), layer: pending.layer, expectedHeightMm: pending.expectedHeightMm}} : {})},
      problems: verdict.status === 'suspect_no_extrusion' ? [{code: 'physical-no-extrusion', severity: 'error', message: 'Possible extrusion failure.'}] : []};
  };
  const judge = async ({prompt}) => /layer 1,/.test(prompt) ? {visibility: 'clear', footprintVisible: true, deposition: 'unknown'} : EMPTY_PLATE;
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const events = [];
  const monitor = new PrintMonitorRunner({projectId: randomUUID(), printId: randomUUID(), destinationId: 'current', printerName: 'Bambu Lab P1S', jobName: JOB, dispatchedAtMs: T0}, {
    clock, read: async () => ({observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...running(1 + Math.round((clock.t - T0) / 10_000), now(mcp))}),
    milestones: () => [], check: (a, s) => checkPrintFrame(mcp.session, a, judge, s), save: async () => {}, end: async () => {}, emit: async d => { events.push(d); }});
  const signal = new AbortController().signal;
  for (let i = 0; i < 5; i++) { await monitor.step(signal); await monitor.checked(); clock.t += 10_000; }
  assert.deepEqual(mcp.observations.map(o => [o.frame_id, o.deposition]), [[first.id, 'unknown'], [later.id, 'absent']]);
  assert.equal(events.filter(e => e.type === 'print.check').length, 1);
});

test('after the printer says it finished, the card keeps saying the camera showed nothing coming out', () => {
  const shared = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/print-check.json', import.meta.url), 'utf8'));
  const status = objectStatus(shared.printedProject);
  assert.deepEqual(status, shared.printedProject.status);
  assert.deepEqual([status.phase, status.tint], ['printed', 'orange']);
  assert.equal(status.text, `The printer says it's done. ${shared.line}`);
  assert.match(objectStatus({...shared.printedProject, print: {...shared.printedProject.print, monitor: {...shared.printedProject.print.monitor, checkSent: undefined}}}).text, /^Printed /);
});

// ---------------------------------------------------------------------------
// Review of #745 (Muse, Nov 12): the warning survives once raised, a skipped check never starves later ones, and a
// crossed read never sends the check without the MCP's words.

const MCP_WORDS = 'Possible extrusion failure: the expected print area appeared empty. Check the print.';
const SUSPECT = {code: 'physical-no-extrusion', severity: 'error', message: MCP_WORDS};
/** The monitor with a scripted camera check: `results` are what each check call resolves to, in order. */
function scripted({reports, results = []}) {
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const events = [], saves = [], kept = new Map(), asked = [];
  const queue = [...reports], answers = [...results];
  const target = {projectId: randomUUID(), printId: randomUUID(), destinationId: 'current', printerName: 'Bambu Lab P1S', jobName: JOB, dispatchedAtMs: T0};
  const monitor = new PrintMonitorRunner(target, {clock, milestones: () => [50],
    read: async () => ({observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...queue.shift()}),
    frame: async id => `prints/${target.printId}/frames/${id}.jpg`,
    keepFrame: async (id, jpeg) => { kept.set(id, jpeg); return `prints/${target.printId}/frames/${id}.jpg`; },
    check: async assessment => { asked.push(assessment.frameId); return answers.length ? answers.shift() : undefined; },
    save: async (m, live) => { saves.push({m, live}); }, end: async () => {}, emit: async d => { events.push(d); }});
  const signal = new AbortController().signal;
  return {events, saves, kept, asked, monitor, target, types: () => events.map(e => e.type),
    async steps(n) { for (let i = 0; i < n; i++) { await monitor.step(signal); await monitor.checked(); clock.t += 10_000; } }};
}
const asking = frame => ({required: true, frameId: frame.id, referenceFrameIds: [], layer: frame.layer, expectedHeightMm: frame.expectedHeightMm, expectedFootprintMm: FOOTPRINT});

test('review 1: after the check, nothing more is judged, and the card and the done keep the MCP\'s words even when a later report drops them', async () => {
  const later = savedFrame(EMPTY, {role: 'periodic', layer: 21, expectedHeightMm: 4.2});
  const h = scripted({reports: [
    running(11, {physical: {status: 'suspect_no_extrusion', evidence: [], assessment: asking(later)}, problems: [SUSPECT]}),
    // The MCP's verdict falls back to unknown (a later observation, or a version without the sticky verdict).
    running(21, {physical: {status: 'unknown', evidence: [], assessment: asking(later)}, problems: []}),
    running(30, {physical: {status: 'unknown', evidence: []}, problems: []}),
    {state: 'finished', job: {name: JOB, progress: 100, layer: 265, totalLayers: 265}, physical: {status: 'unknown', evidence: []}, problems: []},
  ]});
  await h.steps(4);
  assert.deepEqual(h.asked, [], 'no observation after the check could take the verdict back');
  assert.equal(h.types().filter(t => t === 'print.check').length, 1);
  const printing = h.saves.findLast(s => s.live?.state === 'printing');
  assert.equal(printing.m.checkMessage, MCP_WORDS);
  const print = {dispatchedAt: new Date(T0).toISOString(), destination: {name: 'Bambu Lab P1S'}, monitor: printing.m, live: printing.live};
  assert.deepEqual([objectStatus({state: 'printing', print}).text, objectStatus({state: 'printing', print}).tint], [MCP_WORDS, 'orange'], 'the line survives a report without it');
  const done = h.events.find(e => e.type === 'print.done');
  assert.equal(done.detail.reason, MCP_WORDS);
  assert.deepEqual(eventWords('print.done', done.data, {title: 'Forester', printer: 'Bambu Lab P1S', reason: done.detail.reason}).body, MCP_WORDS);
  const ended = h.saves.at(-1).m;
  assert.equal(objectStatus({state: 'printed', print: {...print, monitor: ended}}).text, `The printer says it's done. ${MCP_WORDS}`);
});

test('review 3: a check that resolves without an observation never uses the frame up; no worker is not a try, and later checkpoints still come', async () => {
  const first = savedFrame(PRINTING);
  const present = {frameId: first.id, firstLayer: true, deposition: 'present', jpeg: PRINTING};
  // Nothing could be judged once (a stale record, a changed frame), then it could.
  const once = scripted({reports: [1, 2, 3, 4].map(l => running(l, {physical: {status: 'unknown', evidence: [], assessment: asking(first)}})), results: [undefined, present]});
  await once.steps(4);
  assert.deepEqual(once.asked, [first.id, first.id]);
  assert.equal(once.types().filter(t => t === 'print.first-layer').length, 1);
  // AI off, then Claude Code chosen mid-print: every read re-evaluates, and tries are never spent on it.
  const later = scripted({reports: [1, 2, 3, 4, 5, 6, 7].map(l => running(l, {physical: {status: 'unknown', evidence: [], assessment: asking(first)}})),
    results: ['no-worker', 'no-worker', 'no-worker', 'no-worker', 'no-worker', present]});
  await later.steps(7);
  assert.equal(later.asked.length, 6);
  assert.equal(later.types().filter(t => t === 'print.first-layer').length, 1);
  // A frame that can never be judged is tried a bounded number of times, and the next checkpoint still gets its look.
  const next = savedFrame(EMPTY, {role: 'periodic', layer: 11});
  const stuck = scripted({reports: [1, 2, 3, 4, 5].map(l => running(l, {physical: {status: 'unknown', evidence: [], assessment: asking(first)}}))
    .concat([running(11, {physical: {status: 'unknown', evidence: [], assessment: asking(next)}})])});
  await stuck.steps(6);
  assert.deepEqual(stuck.asked, [first.id, first.id, first.id, next.id]);
});

test('review 4: a read that crossed the submit sends nothing yet; the check goes out once, from the report with the MCP\'s verdict and words', async () => {
  const frame = savedFrame(EMPTY);
  const outcome = {frameId: frame.id, firstLayer: true, deposition: 'absent', jpeg: EMPTY, physical: {status: 'suspect_no_extrusion', evidence: [frame.id]}};
  const h = scripted({results: [outcome], reports: [
    running(1, {physical: {status: 'unknown', evidence: [], assessment: asking(frame)}}),
    running(2, {physical: {status: 'unknown', evidence: []}}),                         // generated before the submit landed
    running(3, {physical: {status: 'suspect_no_extrusion', evidence: [frame.id]}}),    // the verdict, no words yet
    running(4, {physical: {status: 'suspect_no_extrusion', evidence: [frame.id]}, problems: [SUSPECT]}),
    running(5, {physical: {status: 'suspect_no_extrusion', evidence: [frame.id]}, problems: [SUSPECT]}),
  ]});
  await h.steps(3);
  assert.equal(h.types().includes('print.check'), false, 'never "Check the print." with no words');
  await h.steps(2);
  const checks = h.events.filter(e => e.type === 'print.check');
  assert.equal(checks.length, 1);
  assert.equal(eventWords('print.check', checks[0].data, {title: 'Forester', printer: 'Bambu Lab P1S'}).body, MCP_WORDS);
  assert.deepEqual(h.kept.get(checks[0].id), EMPTY, 'with the judged frame');
});

test('review minors: an MCP without counterpart_print_assess gets no judgement; uppercase hashes match; only a preparation frame is a reference', async () => {
  const never = async () => { throw new Error('the worker must not run'); };
  const frame = savedFrame(EMPTY);
  const noAssess = fakeMcp({frames: [frame], tools: ['counterpart_print_record']});
  assert.equal(await checkPrintFrame(noAssess.session, assessmentFor(frame), never, new AbortController().signal), undefined);
  const upper = savedFrame(EMPTY, {sha256: sha(EMPTY).toUpperCase()});
  const a = fakeMcp({frames: [upper]});
  assert.equal((await checkPrintFrame(a.session, assessmentFor(upper), scriptedJudge({[sha(EMPTY)]: EMPTY_PLATE}).judge, new AbortController().signal)).deposition, 'absent');
  const notBaseline = savedFrame(PRINTING, {role: 'periodic', layer: 11}), current = savedFrame(EMPTY);
  const b = fakeMcp({frames: [notBaseline, current]});
  const {judge, seen} = scriptedJudge({[sha(EMPTY)]: EMPTY_PLATE});
  await checkPrintFrame(b.session, assessmentFor(current, [notBaseline]), judge, new AbortController().signal);
  assert.equal(seen[0].referenceFile, false);
  assert.equal(b.observations[0].reference_frame_id, undefined, 'the observation is kept, the reference left out');
});
