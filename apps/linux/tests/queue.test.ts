import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverQueue, queueReady, markSending } from "../src/queue";
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
