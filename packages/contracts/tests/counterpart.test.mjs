import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as c from '../dist/counterpart.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/counterpart-v1.json', import.meta.url), 'utf8'));

test('the wire fixtures cover every event type once, in order, and each one validates', () => {
  // `events` keeps the 20 samples the apps' decode tests count; later types are in their own keys.
  const all = [...fixture.events, ...fixture.projectEvents];
  assert.deepEqual(all.map(event => event.type), [...c.COUNTERPART_EVENT_TYPES]);
  for (const event of all) c.CounterpartEventSchema.parse(event);
  assert.deepEqual(all.map(event => event.seq), all.map((_, index) => index + 1));
  assert.equal(fixture.events.length, 20);
});

test('every other wire fixture validates against its schema', () => {
  for (const page of [fixture.eventsPage, fixture.eventsPageTruncated, fixture.eventsPageReset]) c.EventsPageSchema.parse(page);
  assert.deepEqual([...fixture.statuses, ...fixture.newStatuses].map(status => c.ObjectStatusSchema.parse(status).phase), [...c.PROJECT_PHASES]);
  c.PrintLiveSchema.parse(fixture.printLive);
  c.PrintMonitorSchema.parse(fixture.printMonitor);
  c.PrintSettingsSchema.parse(fixture.printSettings);
  c.PrintEstimateSchema.parse(fixture.estimate);
  for (const destination of fixture.destinations) c.PrinterDestinationSchema.parse(destination);
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
