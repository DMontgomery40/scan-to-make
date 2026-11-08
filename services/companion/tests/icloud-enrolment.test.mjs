import test from 'node:test';
import assert from 'node:assert/strict';
import {rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {IcloudEnrolment, ENROLMENT_TOKEN_LIFETIME_MS, ENROLMENT_TOKEN_REPLACE_MS} from '../dist/icloud-enrolment.js';
import {tempDir} from './support/temp.mjs';

async function setup(t) {
  const root = await tempDir('icloud-enrolment-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'private-auth', 'mac-id');
  const clock = {now: 1000};
  return {path, clock, enrolment: new IcloudEnrolment(path, {now: () => clock.now})};
}

test('simultaneous redemption grants one device and immediately replaces the published token', async t => {
  const {enrolment} = await setup(t);
  const token = await enrolment.token();
  const replies = await Promise.all(Array.from({length: 20}, () => enrolment.redeem(token.macId, token.token)));
  assert.equal(replies.filter(Boolean).length, 1);
  assert.notEqual((await enrolment.token()).token, token.token);
});

test('rotation retains the previous token until its expiry and keeps the replacement valid', async t => {
  const {enrolment, clock} = await setup(t);
  const first = await enrolment.token();
  clock.now += ENROLMENT_TOKEN_REPLACE_MS;
  const second = await enrolment.token();
  assert.notEqual(first.token, second.token);
  assert.equal(await enrolment.redeem(first.macId, first.token), true);
  clock.now = second.expiresAt - 1;
  assert.equal(await enrolment.redeem(second.macId, second.token), true);
});

test('a token is expired exactly at its deadline', async t => {
  const {enrolment, clock} = await setup(t);
  const first = await enrolment.token();
  clock.now += ENROLMENT_TOKEN_LIFETIME_MS;
  assert.equal(await enrolment.redeem(first.macId, first.token), false);
});

test('restart preserves the private Mac identity but invalidates tokens held only in memory', async t => {
  const {enrolment, path} = await setup(t);
  const first = await enrolment.token();
  const restarted = new IcloudEnrolment(path);
  assert.equal(await restarted.macId(), first.macId);
  assert.equal(await restarted.redeem(first.macId, first.token), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
