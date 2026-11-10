import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoverQueue,
  queueReady,
  markSending,
  noteAttempt,
} from "../src/queue";
const item = {
  id: "1",
  projectId: "p",
  note: "Round this edge",
  photos: ["one.jpg"],
  state: "queued" as const,
};
test("an interrupted send becomes uncertain and cannot replay", () => {
  const sending = markSending([item], "1");
  assert.equal(sending[0].state, "sending");
  const recovered = recoverQueue(sending);
  assert.equal(recovered[0].state, "uncertain");
  assert.equal(queueReady(recovered, "p", false), undefined);
});
test("a queued correction waits while active and preserves photo ownership", () => {
  assert.equal(queueReady([item], "p", true), undefined);
  assert.deepEqual(queueReady([item], "p", false)?.photos, ["one.jpg"]);
  assert.equal(queueReady([item], "other", false), undefined);
});
test("one note keeps one id across tries; changed words are a new note", () => {
  let next = 0;
  const id = () => `id-${++next}`;
  const first = noteAttempt(undefined, "Thicker walls", id);
  assert.deepEqual(first, { text: "Thicker walls", id: "id-1" });
  assert.equal(noteAttempt(first, "Thicker walls", id), first);
  assert.equal(noteAttempt(first, "Thicker walls, 3 mm", id).id, "id-2");
  // After a send that worked the caller forgets the attempt, so the same words again are a new note.
  assert.equal(noteAttempt(undefined, "Thicker walls", id).id, "id-3");
  assert.match(noteAttempt(undefined, "x").id, /^[A-Za-z0-9-]{8,64}$/);
});
