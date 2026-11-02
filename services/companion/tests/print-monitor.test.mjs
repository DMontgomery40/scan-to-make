import test from 'node:test';
import assert from 'node:assert/strict';
import {PrintMonitorRunner, MONITOR, matchJob, milestonesFor} from '../dist/printing/monitor.js';

const T0 = Date.parse('2026-11-01T18:00:00.000Z');
const JOB = 'checked-1b2c-Mic mount';
/** A scripted printer and a fake clock: every test is deterministic and instant. */
function harness({reports = [], milestones = '50', state, fallback = false, taskId, frame = async id => `prints/p/frames/${id}.jpg`, frameCapMs} = {}) {
  const clock = {t: T0, sleeps: [], now() { return this.t; }, async sleep(ms) { this.sleeps.push(ms); this.t += ms; }};
  const events = [], saves = [], ends = [];
  let queue = [...reports];
  const read = async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('script ran out');
    if (next instanceof Error) throw next;
    return {observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...next};
  };
  const target = {projectId: '3f1c2a9e-5b7d-4e21-9a6f-0c8d1e2f3a4b', printId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', destinationId: 'current',
    printerName: 'Bambu Lab P1S', jobName: JOB, ...(taskId ? {taskId} : {}), dispatchedAtMs: T0, estimate: {seconds: 2575, grams: 16.7}};
  const monitor = new PrintMonitorRunner(target, {clock, read, frame, fallback, frameCapMs, milestones: () => milestonesFor(milestones),
    save: async (m, live) => { saves.push({m, live}); },
    end: async (end, report, m) => { ends.push({end, state: report?.state, m}); },
    emit: async draft => { events.push(draft); }}, state);
  const signal = new AbortController().signal;
  return {clock, events, saves, ends, monitor, signal, push: (...more) => { queue.push(...more); }, types: () => events.map(e => e.type),
    async steps(n, everyMs = 10_000) { for (let i = 0; i < n; i++) { await monitor.step(signal); clock.t += everyMs; } }};
}
const printing = (progress, layer, extra = {}) => ({state: 'printing', job: {name: JOB, progress, layer, totalLayers: 100, remainingSec: (100 - progress) * 30}, ...extra});

test('a print that starts, crosses a layer and the halfway mark, and finishes raises each event once, with frames', async () => {
  const h = harness({reports: [
    {state: 'finished', job: {name: 'previous part', progress: 100}},   // the last job's leftover report
    {state: 'preparing', job: {name: JOB, progress: 0, stage: 'Heating the bed'}},
    printing(1, 1), printing(3, 2), printing(3, 2), printing(49, 49), printing(51, 51), printing(52, 52),
    {state: 'finished', job: {name: JOB, progress: 100, layer: 100, totalLayers: 100}},
  ]});
  await h.steps(1, 3000);
  assert.deepEqual(h.types(), []);
  await h.steps(1, 3000);
  assert.deepEqual(h.types(), ['print.started']);
  assert.equal(h.events[0].data.stage, 'Heating the bed');
  assert.equal(h.events[0].data.estimateSec, 2575);
  assert.equal(h.monitor.state.phase, 'watching');
  await h.steps(7);
  assert.deepEqual(h.types(), ['print.started', 'print.status', 'print.first-layer', 'print.status', 'print.status', 'print.milestone', 'print.status', 'print.status', 'print.done']);
  const byType = Object.fromEntries(h.events.map(e => [e.type, e]));
  assert.equal(byType['print.milestone'].data.progress, 50);
  assert.match(byType['print.milestone'].frame, /^prints\/p\/frames\/.+\.jpg$/);
  assert.ok(byType['print.first-layer'].frame);
  assert.ok(byType['print.done'].frame);
  assert.equal(byType['print.started'].frame, undefined);
  assert.deepEqual(h.ends.map(e => e.end), ['done']);
  assert.deepEqual(h.monitor.state.milestonesSent, [50]);
  assert.equal(h.monitor.state.phase, 'ended');
  // No status for an unchanged report less than 60 s after the last one.
  const statuses = h.events.filter(e => e.type === 'print.status').map(e => e.data.progress);
  assert.deepEqual(statuses, [1, 3, 49, 51, 52]);
  // Every saved state is the durable record the restart resumes from.
  assert.equal(h.saves.at(-1).m.endState, 'done');
  assert.equal(h.saves.at(-1).live.state, 'finished');
});

test('a print that never appears within 180 s is "not started", and nothing claims it printed', async () => {
  const idle = {state: 'idle'};
  const h = harness({reports: Array(70).fill(idle)});
  // Reads at 0, 3, …, 177 s find nothing; the read at 180 s ends it.
  await h.steps(MONITOR.startWindowMs / MONITOR.startPollMs, MONITOR.startPollMs);
  assert.deepEqual(h.types(), []);
  await h.steps(1, MONITOR.startPollMs);
  assert.deepEqual(h.types(), ['print.not-started']);
  assert.deepEqual(h.ends.map(e => e.end), ['not-started']);
  // The run loop reads every 3 s while starting.
  const runner = harness({reports: Array(80).fill(idle)});
  assert.equal(await runner.monitor.run(runner.signal), 'not-started');
  assert.ok(runner.clock.sleeps.every(ms => ms === MONITOR.startPollMs));
  assert.ok(runner.clock.t - T0 >= MONITOR.startWindowMs && runner.clock.t - T0 < MONITOR.startWindowMs + MONITOR.startPollMs * 2);
});

test('someone else\'s print running instead of ours is "replaced", never reported as ours', async () => {
  const h = harness({reports: [{state: 'printing', job: {name: 'a different part', progress: 12}}]});
  await h.steps(1);
  assert.deepEqual(h.ends.map(e => e.end), ['replaced']);
  assert.deepEqual(h.types(), []);
  const later = harness({reports: [printing(10, 10), {state: 'printing', job: {name: 'a different part', progress: 1}}]});
  await later.steps(2);
  assert.deepEqual(later.ends.map(e => e.end), ['replaced']);
});

test('lost contact: three failed reads say "still trying" once, reads slow to 30 s, and recovery carries on', async () => {
  const fail = new Error('EHOSTUNREACH');
  const h = harness({reports: [printing(10, 10), fail, fail, fail, fail, printing(12, 12)]});
  const run = async () => { await h.monitor.step(h.signal); };
  await run(); await run(); await run();
  assert.equal(h.types().includes('print.unreachable'), false);
  await run();
  assert.equal(h.types().filter(t => t === 'print.unreachable').length, 1);
  assert.ok(h.monitor.state.unreachableSince);
  await run();
  assert.equal(h.types().filter(t => t === 'print.unreachable').length, 1);
  await run();
  assert.equal(h.monitor.state.unreachableSince, undefined);
  assert.equal(h.types().at(-1), 'print.status');
  assert.equal(h.ends.length, 0, 'never a failure by itself');
  const cadence = harness({reports: [printing(10, 10), fail, fail, fail, printing(11, 11), {state: 'finished', job: {name: JOB, progress: 100}}]});
  await cadence.monitor.run(cadence.signal);
  assert.deepEqual(cadence.clock.sleeps, [10_000, 10_000, 10_000, 30_000, 10_000]);
});

test('offline for 60 s counts as lost contact; a printer silent for 12 h ends the watch honestly', async () => {
  const h = harness({reports: [printing(10, 10), ...Array(8).fill({state: 'offline'})]});
  await h.steps(1);
  await h.steps(6);
  assert.equal(h.types().filter(t => t === 'print.unreachable').length, 0);
  await h.steps(1);
  assert.equal(h.types().filter(t => t === 'print.unreachable').length, 1);
  const silent = harness({reports: [new Error('down'), new Error('down')]});
  await silent.monitor.step(silent.signal);
  silent.clock.t = T0 + MONITOR.giveUpAfterMs;
  await silent.monitor.step(silent.signal);
  assert.deepEqual(silent.ends.map(e => e.end), ['sent'], 'silence is not evidence that nothing started');
});

test('pause, resume, failure and cancellation each raise their own event', async () => {
  const paused = {state: 'paused', job: {name: JOB, progress: 61, layer: 61, totalLayers: 100},
    problems: [{code: '0700_2000_0002_0001', severity: 'error', message: 'AMS slot 1 ran out of filament'}]};
  const h = harness({reports: [printing(60, 60), paused, paused, printing(61, 61), {state: 'failed', job: {name: JOB, progress: 61}}]});
  await h.steps(5);
  assert.deepEqual(h.types().filter(t => t !== 'print.status'), ['print.started', 'print.paused', 'print.resumed', 'print.failed']);
  assert.equal(h.events.find(e => e.type === 'print.paused').data.problems[0].message, 'AMS slot 1 ran out of filament');
  assert.ok(h.events.find(e => e.type === 'print.paused').frame);
  assert.ok(h.events.find(e => e.type === 'print.failed').frame);
  assert.equal(h.events.find(e => e.type === 'print.resumed').frame, undefined);
  assert.deepEqual(h.ends.map(e => e.end), ['failed']);
  const c = harness({reports: [printing(5, 5), {state: 'cancelled', job: {name: JOB, progress: 5}}]});
  await c.steps(2);
  assert.deepEqual(c.ends.map(e => e.end), ['cancelled']);
  assert.equal(c.events.at(-1).type, 'print.cancelled');
  assert.equal(c.events.at(-1).frame, undefined);
});

test('a restarted companion resumes without repeating milestones and without back-filling ones it missed', async () => {
  const saved = {phase: 'watching', startedAt: new Date(T0).toISOString(), lastReportAt: new Date(T0 + 600_000).toISOString(), milestonesSent: [25, 50], firstLayerSent: true};
  // Back within a minute: a milestone crossed while restarting is still news.
  const soon = harness({milestones: '25-50-75', state: saved, reports: [printing(76, 76)]});
  soon.clock.t = T0 + 630_000;
  await soon.steps(1);
  assert.deepEqual(soon.types(), ['print.milestone', 'print.status']);
  assert.equal(soon.events[0].data.progress, 75);
  // After a long sleep: recorded as sent, no event; the end is still delivered.
  const slept = harness({milestones: '25-50-75', state: saved, reports: [printing(80, 80), {state: 'finished', job: {name: JOB, progress: 100}}]});
  slept.clock.t = T0 + 3_600_000;
  await slept.steps(2);
  assert.deepEqual(slept.types(), ['print.status', 'print.done']);
  assert.deepEqual(slept.monitor.state.milestonesSent, [25, 50, 75]);
  // Nothing already in milestonesSent is ever sent again.
  const again = harness({milestones: '50', state: {...saved, milestonesSent: [50]}, reports: [printing(55, 55)]});
  again.clock.t = T0 + 610_000;
  await again.steps(1);
  assert.deepEqual(again.types(), ['print.status']);
});

test('milestone settings choose which percentages are news; a jump across several sends only the highest', async () => {
  assert.deepEqual(milestonesFor('off'), []);
  assert.deepEqual(milestonesFor('every-10'), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const h = harness({milestones: 'every-10', reports: [printing(5, 5), printing(9, 9), printing(34, 34)]});
  await h.steps(3);
  const milestones = h.events.filter(e => e.type === 'print.milestone');
  assert.deepEqual(milestones.map(e => e.data.progress), [30]);
  assert.deepEqual(h.monitor.state.milestonesSent, [10, 20, 30]);
  const off = harness({milestones: 'off', reports: [printing(5, 5), printing(90, 90)]});
  await off.steps(2);
  assert.equal(off.types().includes('print.milestone'), false);
});

test('a slow camera never holds an event back: after the cap it goes without a frame', async () => {
  const h = harness({frame: () => new Promise(() => {}), frameCapMs: 20, reports: [printing(1, 1), printing(3, 3)]});
  await h.steps(2);
  const firstLayer = h.events.find(e => e.type === 'print.first-layer');
  assert.ok(firstLayer);
  assert.equal(firstLayer.frame, undefined);
});

test('our job is matched by the printer task id when there is a real one, else by its job name', () => {
  const report = (id, name) => ({state: 'printing', observedAt: '', problems: [], source: 'counterpart', job: {name, ...(id === undefined ? {} : {id})}});
  assert.equal(matchJob({taskId: '1730', jobName: JOB}, report('1730', 'renamed')), 'ours');
  assert.equal(matchJob({taskId: '1730', jobName: JOB}, report('99', JOB)), 'other');
  assert.equal(matchJob({taskId: '0', jobName: JOB}, report('0', JOB)), 'ours', 'P1S sends task_id "0": not a key');
  assert.equal(matchJob({jobName: JOB}, report('0', 'other job')), 'other');
  assert.equal(matchJob({jobName: 'sliced.gcode'}, report(undefined, 'sliced')), 'ours');
  assert.equal(matchJob({jobName: JOB}, {state: 'idle', observedAt: '', problems: [], source: 'counterpart'}), 'none');
  // No identity: only a job named after our file is ours, and nothing is "someone else's".
  assert.equal(matchJob({fileBase: 'part_flat_sliced'}, report('0', 'checked-1b2c-part_flat_sliced')), 'ours');
  assert.equal(matchJob({fileBase: 'part_flat_sliced'}, report('0', 'another job')), 'none');
});

test('older MCP installs are read more slowly: every 10 s while starting, every 30 s while watching', async () => {
  const h = harness({fallback: true, reports: [{state: 'idle'}, printing(1, 1), printing(2, 2), {state: 'finished', job: {name: JOB, progress: 100}}]});
  await h.monitor.run(h.signal);
  assert.deepEqual(h.clock.sleeps, [MONITOR.fallbackStartPollMs, MONITOR.fallbackWatchPollMs, MONITOR.fallbackWatchPollMs]);
});

test('a job named after our file is adopted only while it runs; an earlier finished one with that name is not ours', async () => {
  const leftover = {state: 'finished', job: {name: 'checked-OLD-clean_flat_sliced', progress: 100}};
  const fresh = {state: 'printing', job: {name: 'checked-NEW-clean_flat_sliced', progress: 1}};
  const adopted = [];
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const queue = [leftover, leftover, fresh, {state: 'finished', job: {name: 'checked-NEW-clean_flat_sliced', progress: 100}}];
  const ends = [];
  const runner = new PrintMonitorRunner({projectId: 'p', printId: 'x', destinationId: 'd', printerName: 'P1S', fileBase: 'clean_flat_sliced', dispatchedAtMs: T0}, {
    clock, read: async () => ({observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...queue.shift()}),
    save: async () => {}, end: async end => { ends.push(end); }, emit: async () => {}, milestones: () => [50], adopted: async name => { adopted.push(name); }});
  const signal = new AbortController().signal;
  await runner.step(signal); await runner.step(signal);
  assert.deepEqual(ends, [], 'a finished leftover is not adopted');
  await runner.step(signal);
  assert.deepEqual(adopted, ['checked-NEW-clean_flat_sliced']);
  await runner.step(signal);
  assert.deepEqual(ends, ['done']);
});

test('a reused job name\'s leftover ending is not ours until this print has been seen running', async () => {
  const clock = {t: T0, now() { return this.t; }, async sleep(ms) { this.t += ms; }};
  const queue = [{state: 'finished', job: {name: 'sliced.gcode', progress: 100}}, {state: 'printing', job: {name: 'sliced.gcode', progress: 1}},
    {state: 'finished', job: {name: 'sliced.gcode', progress: 100}}];
  const ends = [], events = [];
  const runner = new PrintMonitorRunner({projectId: 'p', printId: 'x', destinationId: 'd', printerName: 'Voron', jobName: 'sliced.gcode', dispatchedAtMs: T0}, {
    clock, read: async () => ({observedAt: new Date(clock.t).toISOString(), problems: [], source: 'counterpart', ...queue.shift()}),
    save: async () => {}, end: async end => { ends.push(end); }, emit: async draft => { events.push(draft.type); }, milestones: () => []});
  const signal = new AbortController().signal;
  await runner.step(signal);
  assert.deepEqual(ends, [], 'an earlier sliced.gcode finishing proves nothing about this one');
  await runner.step(signal); await runner.step(signal);
  assert.deepEqual(ends, ['done']);
  // A Bambu checked-<uuid> name is unique to its dispatch: its ending counts even when first seen ended (a restart).
  const {uniqueIdentity} = await import('../dist/printing/monitor.js');
  assert.equal(uniqueIdentity({jobName: 'checked-5858f0f4-292c-4b79-8b39-84f1a340f363-clean_flat_sliced'}), true);
  assert.equal(uniqueIdentity({jobName: 'sliced.gcode'}), false);
  assert.equal(uniqueIdentity({taskId: '0', jobName: 'sliced'}), false);
  assert.equal(uniqueIdentity({taskId: '1730485800'}), true);
});

// The first real end-to-end print from the app (2026-11-02, stove gap filler 2f0a0229 on the P1S): the printer
// heated, cleaned and levelled for ten minutes at layer 0 of 52, then aborted during auto bed leveling with HMS
// 0300_0D00_0002_0001, which Bambu Studio has no text for. Counterpart said "Printing · 3% · 2 h 55 min left".
const HMS = {code: '0300_0D00_0002_0001', severity: 'error', message: 'Printer reported 0300_0D00_0002_0001; Bambu Studio v02.08.02.61 has no description for it.',
  url: 'https://e.bambulab.com/index.php?e=03000D0000020001&s=device_hms&lang=en'};
const stove = (progress, remainingSec, stage, problems = []) => ({state: 'printing', job: {name: JOB, progress, remainingSec, layer: 0, totalLayers: 52, ...(stage ? {stage} : {})}, problems});
const STOVE_REPLAY = [
  // 06:57:32 the printer took the job, still showing the previous job's numbers.
  [{state: 'preparing', job: {name: JOB, progress: 100, remainingSec: 0, layer: 30, totalLayers: 30}}, 'print.started', 'Bambu Lab P1S started Stove gap filler', 'Getting ready', 'Getting ready'],
  [stove(0, 10800), 'print.status', 'Stove gap filler', 'Getting ready', 'Getting ready'],
  [stove(0, 10800, 'Waiting for heatbed to reach target temperature'), 'print.status', 'Stove gap filler',
    'Getting ready · Waiting for heatbed to reach target temperature', 'Getting ready · Waiting for heatbed to reach target temperature'],
  [stove(2, 10560, 'Waiting for heatbed to reach target temperature'), 'print.status', 'Stove gap filler',
    'Getting ready · Waiting for heatbed to reach target temperature', 'Getting ready · Waiting for heatbed to reach target temperature'],
  [stove(3, 10500, 'Cleaning nozzle tip'), 'print.status', 'Stove gap filler', 'Getting ready · Cleaning nozzle tip', 'Getting ready · Cleaning nozzle tip'],
  [stove(3, 10500, 'Cleaning nozzle tip', [HMS]), 'print.status', 'Stove gap filler', 'Getting ready · Cleaning nozzle tip', 'Getting ready · Cleaning nozzle tip'],
  [stove(3, 10500, 'Auto bed leveling', [HMS]), 'print.status', 'Stove gap filler', 'Getting ready · Auto bed leveling', 'Getting ready · Auto bed leveling'],
  // 07:08:04 the job is gone: the printer is idle with the code that stopped it.
  [{state: 'idle', problems: [HMS]}, 'print.failed', 'Bambu Lab P1S stopped Stove gap filler', 'The printer stopped (0300_0D00_0002_0001).', undefined],
];

test('the stove gap filler replay: getting ready is never "Printing · 3%", and the abort is the printer\'s own words', async () => {
  const {eventWords, objectStatus, printEndFailure} = await import('../dist/events/words.js');
  const h = harness({reports: STOVE_REPLAY.map(([report]) => report)});
  const context = {title: 'Stove gap filler', printer: 'Bambu Lab P1S'};
  for (const [index, [, type, title, body, line]] of STOVE_REPLAY.entries()) {
    const before = h.events.length;
    await h.steps(1, 60_000);
    const event = h.events.at(-1);
    assert.equal(h.events.length, before + 1, `step ${index}: one event`);
    assert.equal(event.type, type, `step ${index}`);
    const words = eventWords(event.type, event.data, context);
    assert.deepEqual([words.title, words.body], [title, body], `step ${index}`);
    if (type !== 'print.failed') {
      // No percent, no time left, no layer count (0, or the previous job's 30 of 30) while it gets ready.
      assert.equal(event.data.state, 'preparing', `step ${index}`);
      for (const key of ['progress', 'remainingSec', 'endsAt', 'layer', 'totalLayers']) assert.equal(key in event.data, false, `step ${index}: ${key}`);
      const live = h.saves.at(-1).live;
      assert.deepEqual([live.state, live.job.progress, live.job.remainingSec, live.endsAt], ['preparing', undefined, undefined, undefined], `step ${index}`);
      const status = objectStatus({state: 'printing', print: {destination: {name: 'Bambu Lab P1S'}, dispatchedAt: '2026-11-02T06:56:24Z', monitor: {phase: 'watching'}, live}});
      assert.deepEqual([status.phase, status.text], ['preparing', line], `step ${index}`);
      assert.doesNotMatch(status.text, /Printing|%|left/, `step ${index}`);
    }
  }
  // Preparing never counted as the first layer or the halfway mark (the started report showed 100% and 30 of 30).
  assert.deepEqual([h.monitor.state.firstLayerSent, h.monitor.state.milestonesSent], [false, []]);
  assert.equal(h.types().includes('print.first-layer'), false);
  // The failure is loud: time-sensitive, with the camera frame, in the printer's own words and nothing more.
  const failed = h.events.at(-1);
  assert.equal(eventWords('print.failed', failed.data, context).notify, 'timeSensitive');
  assert.match(failed.frame, /^prints\/p\/frames\/.+\.jpg$/);
  assert.deepEqual(failed.data.problems, [{code: HMS.code, message: HMS.message}]);
  assert.deepEqual(h.ends.map(end => end.end), ['failed']);
  // The project's line, as the service records the ending.
  const failure = printEndFailure('failed', {...context, problem: HMS});
  assert.equal(failure, 'The printer stopped (0300_0D00_0002_0001).');
  assert.deepEqual(objectStatus({state: 'failed', failure}), {phase: 'failed', text: failure, symbol: 'exclamationmark.triangle', tint: 'red'});
});

test('getting ready ends at layer 1: then it is "Printing · N% · T left"; a stopped print says the printer\'s words', async () => {
  const {eventWords, objectStatus, printerStopped, printPreparing} = await import('../dist/events/words.js');
  const live = {state: 'printing', job: {progress: 4, remainingSec: 9900, layer: 1, totalLayers: 52}};
  const status = objectStatus({state: 'printing', print: {destination: {name: 'Bambu Lab P1S'}, dispatchedAt: '2026-11-02T06:56:24Z', monitor: {phase: 'watching'}, live}});
  assert.equal(status.text, 'Printing on Bambu Lab P1S · 4% · 2 h 45 min left');
  assert.equal(eventWords('print.status', {state: 'printing', progress: 4, remainingSec: 9900, layer: 1, totalLayers: 52}, {title: 'Stove gap filler'}).body, '4% · 2 h 45 min left · layer 1 of 52');
  // Without a layer count (mcp-3D-printer-server), Bambu's preparation stages say; a mid-print filament change doesn't.
  assert.equal(printPreparing('printing', {stage: 'Auto bed leveling'}), true);
  assert.equal(printPreparing('printing', {stage: 'Changing filament'}), false);
  assert.equal(printPreparing('printing', {stage: 'Heating nozzle', layer: 20}), false, 'from layer 1 it prints');
  assert.equal(printPreparing('paused', {layer: 0}), false, 'paused says paused');
  assert.equal(printerStopped({code: '0700_2000_0002_0001', message: 'AMS A slot 1 ran out of filament.'}), 'The printer stopped: AMS A slot 1 ran out of filament.');
  assert.equal(printerStopped({code: '0300_8003', message: 'The printer reported error 0300_8003.'}), 'The printer stopped (0300_8003).');
  assert.equal(printerStopped(undefined), 'The printer stopped.');
});

test('a print that reaches layer 1 after getting ready raises its first layer and milestones as before', async () => {
  const h = harness({reports: [
    {state: 'preparing', job: {name: JOB, progress: 100, remainingSec: 0, layer: 30, totalLayers: 30}},
    {state: 'printing', job: {name: JOB, progress: 3, remainingSec: 10500, layer: 0, totalLayers: 100, stage: 'Auto bed leveling'}},
    printing(1, 1), printing(2, 2), printing(51, 51),
  ]});
  await h.steps(5);
  assert.deepEqual(h.types(), ['print.started', 'print.status', 'print.status', 'print.first-layer', 'print.status', 'print.milestone', 'print.status']);
  assert.deepEqual(h.monitor.state.milestonesSent, [50]);
  assert.equal(h.events[2].data.state, 'printing');
  assert.equal(h.events[2].data.progress, 1);
});

test('a failure takes its words from its own report: preparing with no problems, then idle with the code that stopped it', async () => {
  const {printEndFailure} = await import('../dist/events/words.js');
  const h = harness({reports: [{state: 'preparing', job: {name: JOB, stage: 'Auto bed leveling'}}, {state: 'idle', problems: [HMS]}]});
  await h.steps(2);
  assert.deepEqual(h.types(), ['print.started', 'print.failed']);
  // The ending report, not the last one while it ran, is what the service and the saved record see.
  assert.deepEqual(h.ends[0].state, 'idle');
  assert.deepEqual(h.saves.at(-1).live.problems.map(problem => problem.code), [HMS.code]);
  assert.deepEqual(h.events.at(-1).data.problems.map(problem => problem.code), [HMS.code]);
  assert.equal(printEndFailure('failed', {title: 'Stove gap filler', printer: 'Bambu Lab P1S', problem: h.saves.at(-1).live.problems[0]}),
    'The printer stopped (0300_0D00_0002_0001).');
});
