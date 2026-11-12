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
  visibility: 'clear', footprint_visible: true, deposition: 'absent'};
const PLASTIC = {seen: 'Grey printed parts stand on the plate in the middle of the picture.', visibility: 'clear', footprint_visible: true, deposition: 'present'};

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
  for (const answer of [{visibility: 'dark', footprint_visible: true, deposition: 'absent'}, {visibility: 'occluded', footprint_visible: true, deposition: 'present'},
    {visibility: 'out_of_view', footprint_visible: false, deposition: 'absent'}, {visibility: 'clear', footprint_visible: false, deposition: 'absent'}]) {
    const frame = savedFrame(EMPTY);
    const mcp = fakeMcp({frames: [frame]});
    const outcome = await checkPrintFrame(mcp.session, assessmentFor(frame), scriptedJudge({[sha(EMPTY)]: answer}).judge, new AbortController().signal);
    assert.equal(mcp.observations[0].deposition, 'unknown', JSON.stringify(answer));
    assert.equal(mcp.observations[0].visibility, answer.visibility);
    assert.equal(outcome.physical.status, 'unknown');
  }
  assert.equal(visionAnswer({visibility: 'clear', footprint_visible: true, deposition: 'maybe'}), undefined);
  assert.equal(visionAnswer(undefined), undefined);
});

test('an empty-plate reference from before printing goes with the frame, and its own visibility is passed on', async () => {
  const baseline = savedFrame(EMPTY, {role: 'baseline', layer: 0}), frame = savedFrame(EMPTY);
  const mcp = fakeMcp({frames: [baseline, frame]});
  const {judge, seen} = scriptedJudge({[sha(EMPTY)]: {...EMPTY_PLATE, reference_visibility: 'out_of_view', reference_empty: true}});
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
  const unanswered = fakeMcp({frames: [stale]});
  assert.equal(await checkPrintFrame(unanswered.session, assessmentFor(stale), async () => ({nonsense: true}), new AbortController().signal), undefined);
  assert.equal(unanswered.observations.length, 0, 'no usable answer, nothing submitted');
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

test('P0 replay of faf29c4d: an empty first layer is never "first layer\'s down"; it is one time-sensitive check with the empty frame, on the card, and "done" says so', async () => {
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
  const line = "Nothing seems to be coming out of the nozzle on Bambu Lab P1S: the first layer's area is empty in the camera. The printer doesn't detect this itself. Check the print.";
  assert.equal(check.data.problems[0].message, line);
  assert.equal(check.data.problems.length, 1, "the MCP's own line for the same verdict isn't said twice");
  const words = eventWords('print.check', check.data, {title: 'Forester', printer: 'Bambu Lab P1S'});
  assert.deepEqual(words, {title: 'Check Forester on Bambu Lab P1S', body: line, notify: 'timeSensitive'});
  assert.equal(NOTIFY['print.check'], 'timeSensitive');
  // The card: the live report and the status line every layout shows.
  const live = h.saves.findLast(s => s.live?.state === 'printing').live;
  assert.equal(live.problems[0].message, line);
  const status = objectStatus({state: 'printing', print: {dispatchedAt: new Date(T0).toISOString(), destination: {name: 'Bambu Lab P1S'}, monitor: {phase: 'watching'}, live}});
  assert.deepEqual([status.phase, status.text, status.tint], ['printing', line, 'orange']);
  // Firmware FINISH is not a part on the plate.
  const done = h.events.find(e => e.type === 'print.done');
  assert.match(eventWords('print.done', done.data, {title: 'Forester', printer: 'Bambu Lab P1S'}).body, /camera showed nothing coming out/);
  assert.match(printLogLine('print.done', done.data), /says it's done, but the camera showed nothing/);
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
  assert.equal(h.mcp.observations.length, 0, 'an unanswered check submits nothing');
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
  assert.match(check.data.problems[0].message, /the print's area is empty in the camera/);
});
