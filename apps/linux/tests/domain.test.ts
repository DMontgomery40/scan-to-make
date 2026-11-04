import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReadOrder,
  freezePlate,
  guardPlate,
  parseLayers,
  searchProject,
  normalizeQuestion,
  validateAnswer,
} from "../src/domain.ts";
import type { Project } from "../src/types.ts";
const project = {
  id: "p",
  title: "Mount",
  instructions: "25 inches",
  state: "ready",
  photos: [],
  passes: [],
  updatedAtMs: 1,
  createdAtMs: 1,
  plates: [{ id: "a:1", selected: true }],
  directory: "/private/needle",
} as unknown as Project;
test("a print sheet rejects a changed plate and never adopts it", () => {
  const frozen = freezePlate(project);
  assert.equal(frozen, "a:1");
  assert.throws(() =>
    guardPlate(
      { ...project, plates: [{ ...project.plates![0], id: "b:2" }] },
      frozen,
    ),
  );
  assert.equal(frozen, "a:1");
});
test("read issued before a mutation cannot overwrite its result", () => {
  const order = new ReadOrder();
  const a = order.begin();
  order.invalidate();
  assert.equal(order.accept(a), false);
  const b = order.begin();
  const c = order.begin();
  assert.equal(order.accept(c), true);
  assert.equal(order.accept(b), false);
});
test("search includes conversation but excludes paths and identifiers", () => {
  assert.equal(searchProject(project, "25 inches"), true);
  assert.equal(searchProject(project, "needle"), false);
  assert.equal(
    searchProject(
      {
        ...project,
        messages: [
          { id: "secret-id", text: "make it green", atMs: 2, photos: [] },
        ],
      },
      "green",
    ),
    true,
  );
});
test("layer pauses use exact integers within the estimate, unique and sorted", () => {
  assert.deepEqual(parseLayers("5, 2, 5", 6), [2, 5]);
  for (const s of ["1", "2.5", "2oops", "9", "-4"])
    assert.throws(() => parseLayers(s, 6));
});
test("dynamic questions preserve primitives and reject unsupported schema", () => {
  const q = normalizeQuestion({
    id: "q",
    mode: "form",
    message: "Confirm",
    expiresAtMs: 9999999999999,
    requestedSchema: {
      type: "object",
      required: ["ok", "copies"],
      properties: {
        ok: { type: "boolean" },
        copies: { type: "integer", minimum: 1, maximum: 3 },
        route: { type: "string", enum: ["lan", "cloud"] },
      },
    },
  });
  assert.equal(q.supported, true);
  assert.deepEqual(
    validateAnswer(q, { ok: false, copies: "2", route: "lan" }),
    { ok: false, copies: 2, route: "lan" },
  );
  assert.throws(() => validateAnswer(q, { copies: "2" }));
  assert.throws(() => validateAnswer(q, { ok: true, copies: "4" }));
  assert.equal(
    normalizeQuestion({
      id: "q",
      message: "X",
      expiresAtMs: 1,
      requestedSchema: {
        type: "object",
        properties: { nested: { type: "object" } },
      },
    }).supported,
    false,
  );
});
test("a late mutation response cannot replace newer project state", async () => {
  const { newerProject } = await import("../src/domain");
  const newer = { ...project, updatedAtMs: 10, state: "printing" };
  assert.equal(
    newerProject(newer, { ...project, updatedAtMs: 9, state: "ready" }).state,
    "printing",
  );
  assert.equal(newerProject(project, newer).state, "printing");
});
