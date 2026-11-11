import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import * as c from '../dist/counterpart.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/counterpart-v1.json', import.meta.url), 'utf8'));

test('the wire fixtures cover every event type once, in order, and each one validates', () => {
  // `events` keeps the 20 samples the apps' decode tests count; later types are in their own keys,
  // and `macEvents` have no projectId (PRD §8.10).
  const all = [...fixture.events, ...fixture.projectEvents, ...fixture.macEvents];
  assert.deepEqual(all.map(event => event.type).sort(), [...c.COUNTERPART_EVENT_TYPES].sort());
  assert.equal(new Set(all.map(event => event.type)).size, all.length, 'each type once');
  for (const event of all) c.CounterpartEventSchema.parse(event);
  assert.deepEqual(all.map(event => event.seq), all.map((_, index) => index + 1));
  assert.equal(fixture.events.length, 20);
  assert.ok([...fixture.events, ...fixture.projectEvents].every(event => event.projectId) && fixture.macEvents.every(event => !('projectId' in event)));
  for (const update of fixture.mcpUpdates) c.McpUpdateSchema.parse(update);
  // PRD §5.6: there is no bed check; Bambu's own bed levelling finds a full plate.
  assert.ok(!c.COUNTERPART_EVENT_TYPES.includes('plate.blocked'));
});

test('every other wire fixture validates against its schema', () => {
  for (const page of [fixture.eventsPage, fixture.eventsPageTruncated, fixture.eventsPageReset]) c.EventsPageSchema.parse(page);
  assert.deepEqual([...fixture.statuses, ...fixture.newStatuses].map(status => c.ObjectStatusSchema.parse(status).phase), [...c.PROJECT_PHASES]);
  c.PrintLiveSchema.parse(fixture.printLive);
  c.PrintMonitorSchema.parse(fixture.printMonitor);
  c.PrintSettingsSchema.parse(fixture.printSettings);
  c.PrintEstimateSchema.parse(fixture.estimate);
  // KAN-224: Bambu Studio's warning, verbatim, up to the 2000 characters printer-handoff keeps.
  c.PrintEstimateSchema.parse({...fixture.estimate, slicerWarning: 'It seems object clean_flat.stl has floating cantilever. Please re-orient the object or enable support generation.'});
  assert.throws(() => c.PrintEstimateSchema.parse({...fixture.estimate, slicerWarning: 'x'.repeat(2001)}));
  for (const destination of fixture.destinations) c.PrinterDestinationSchema.parse(destination);
  // A printer in both MCPs: each MCP's install, name and versions (PRD §8.10, every MCP keeps its row).
  const both = JSON.parse(readFileSync(new URL('../fixtures/printer-both-mcps.json', import.meta.url), 'utf8'));
  for (const destination of both.destinations) c.PrinterDestinationSchema.parse(destination);
  c.AskSchema.parse(fixture.ask);
  for (const change of fixture.changes) c.ChangeSchema.parse(change);
  for (const stage of fixture.stages) c.PassStageSchema.parse(stage);
  c.CompanionSettingsSchema.parse(fixture.settings);
  for (const upload of fixture.liveActivityTokenUploads) c.LiveActivityTokenUploadSchema.parse(upload);
  c.LiveActivityTokensSchema.parse(fixture.liveActivityTokens);
});

test('events reject unknown fields and types, and frames stay inside the project folder', () => {
  const [event] = fixture.events;
  assert.equal(c.CounterpartEventSchema.safeParse({...event, extra: 1}).success, false);
  assert.equal(c.CounterpartEventSchema.safeParse({...event, type: 'print.exploded'}).success, false);
  assert.equal(c.CounterpartEventSchema.safeParse({...event, frame: '../../auth/auth.json'}).success, false);
  assert.equal(c.LiveActivityTokenUploadSchema.safeParse({}).success, false);
  assert.equal(c.PrintColourSchema.safeParse({amsSlot: 1, external: true}).success, false);
});
