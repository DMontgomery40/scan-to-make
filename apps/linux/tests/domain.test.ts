import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReadOrder,
  estimateRequest,
  freezePlate,
  offeredChoices,
  printRequest,
  shownSlice,
  guardPlate,
  parseLayers,
  searchProject,
  startersShown,
  normalizeQuestion,
  validateAnswer,
  startingChoices,
  designerSettingsWords,
} from "../src/domain.ts";
import type { Project, ReconstructionReview } from "../src/types.ts";
import {
  buildRegionAnswer,
  buildScaleAnswer,
  componentWords,
  formatPreviewExtent,
  parseExtentMm,
  selectionBox,
  suggestedComponent,
} from "../src/domain.ts";
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
const review: ReconstructionReview = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  kind: "region",
  preview: "reconstruction-preview.stl?reviewId=123e4567-e89b-42d3-a456-426614174000",
  previewMeshSha256: "a".repeat(64),
  boundsMin: [0, 0, 0], boundsMax: [10, 4, 2],
  extents: { x: 10, y: 4, z: 2 }, scaleKnown: false,
  suggestion: { type: "component", reason: "Largest piece", extents: { x: 8, y: 4, z: 2 } },
  components: [
    { index: 0, vertices: 100, faces: 50, share: 0.8, boundsMin: [1, 0, 0], boundsMax: [9, 4, 2], extents: { x: 8, y: 4, z: 2 } },
    { index: 1, vertices: 10, faces: 5, share: 0.2, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], extents: { x: 1, y: 1, z: 1 } },
  ],
};
test("reconstruction answers bind to the current review hash and kind", () => {
  assert.deepEqual(buildRegionAnswer(review, { type: "suggested" }),
    { type: "region", previewMeshSha256: "a".repeat(64), selection: { type: "suggested" } });
  assert.deepEqual(buildRegionAnswer(review, { type: "component", index: 1 }).type, "region");
  assert.throws(() => buildRegionAnswer(review, { type: "component", index: 9 }));
  assert.throws(() => buildRegionAnswer({ ...review, previewMeshSha256: undefined }, { type: "suggested" }));
  assert.throws(() => buildScaleAnswer(review, "x", 50));
  const scale = { ...review, kind: "scale" as const, meshSha256: "b".repeat(64), previewMeshSha256: undefined };
  assert.deepEqual(buildScaleAnswer(scale, "y", 42.5),
    { type: "scale", meshSha256: "b".repeat(64), axis: "y", extentMm: 42.5 });
  assert.throws(() => buildScaleAnswer(scale, "y", Number.NaN));
  assert.throws(() => buildScaleAnswer(scale, "y", 0.5));
});
test("crop must be finite, ordered, and overlap the preview", () => {
  assert.equal(buildRegionAnswer(review, { type: "crop", min: [2, 0, 0], max: [5, 4, 2] }).type, "region");
  assert.throws(() => buildRegionAnswer(review, { type: "crop", min: [5, 0, 0], max: [5, 4, 2] }));
  assert.throws(() => buildRegionAnswer(review, { type: "crop", min: [20, 0, 0], max: [30, 4, 2] }));
  assert.throws(() => buildRegionAnswer(review, { type: "crop", min: [Number.NaN, 0, 0], max: [5, 4, 2] }));
});
test("preview units are never labelled mm without a proven scale", () => {
  assert.match(formatPreviewExtent(review, 10), /preview units/);
  assert.doesNotMatch(formatPreviewExtent(review, 10), /mm/);
  assert.equal(formatPreviewExtent({ ...review, scaleKnown: true, scaleMPerUnit: 0.002 }, 10), "20 mm");
  assert.match(formatPreviewExtent({ ...review, scaleKnown: true }, 10), /preview units/);
});
test("suggestion and component boxes drive the highlight; words stay human", () => {
  assert.equal(suggestedComponent(review)?.index, 0);
  assert.deepEqual(selectionBox(review, { type: "suggested" }), { min: [1, 0, 0], max: [9, 4, 2] });
  assert.deepEqual(selectionBox(review, { type: "component", index: 1 }), { min: [0, 0, 0], max: [1, 1, 1] });
  const anchor = { ...review, suggestion: { type: "anchor-region" as const, reason: "Near tap", extents: { x: 2, y: 2, z: 2 } } };
  assert.equal(selectionBox(anchor, { type: "suggested" }), undefined);
  assert.match(componentWords(review.components![0]!), /Piece 1 — 80% of the model · 50 triangles/);
  assert.throws(() => parseExtentMm(""), /between 1 and 10,000 mm/);
  assert.throws(() => parseExtentMm("12x"));
  assert.equal(parseExtentMm("12.5"), 12.5);
});

test("the print sheet's estimate slices exactly what Print sends, and Print sends only the slice whose pictures were shown", () => {
  const filament = { slot: 2, colour: "#FFD200", material: "PLA", name: "Bambu PLA Basic", filamentId: "GFA00", destinationId: "p1s" };
  const choices = { destinationId: "p1s", quality: "fine", strength: "strong", copies: 2, filament, material: "PETG", pauseBeforeLayers: [3, 20] };
  const sha = "a".repeat(64);
  const estimate = estimateRequest("o1", choices);
  // A loaded spool wins over "what's loaded"; the estimate takes every choice Print takes.
  assert.deepEqual(estimate, { id: "o1", destinationId: "p1s", quality: "fine", strength: "strong", copies: 2, filament, pauseBeforeLayers: [3, 20] });
  const { destinationId: _d, ...same } = estimate;
  assert.deepEqual(printRequest("o1", choices, sha, "plate-1"), { ...same, expectedPlate: "plate-1", sliceSha256: sha });
  const plain = { ...choices, filament: undefined, pauseBeforeLayers: [] };
  assert.deepEqual((estimateRequest("o1", plain) as { colour?: unknown }).colour, { material: "PETG" });
  assert.equal("pauseBeforeLayers" in estimateRequest("o1", plain), false);
  assert.equal("expectedPlate" in printRequest("o1", plain, sha), false);
  // Only an estimate whose pictures are of its own sliced file can be printed.
  const views = [
    { name: "top", label: "From above", png: "iVBORw0KGgo=", width: 400, height: 400 },
    { name: "bed_side", label: "From the side", png: "iVBORw0KGgo=", width: 400, height: 200 },
  ];
  const base = { destinationId: "p1s", quality: "fine", strength: "strong" };
  assert.equal(shownSlice({ ...base, sliceSha256: sha, preview: { sha256: sha, views } }), sha);
  assert.equal(shownSlice({ ...base, sliceSha256: sha }), undefined, "an MCP that draws nothing");
  assert.equal(shownSlice({ ...base, sliceSha256: sha, preview: { sha256: "b".repeat(64), views } }), undefined, "pictures of another file");
  assert.equal(shownSlice({ ...base, preview: { sha256: sha, views } }), undefined, "an older companion");
  assert.equal(shownSlice(undefined), undefined);
});

test("the print sheet sends only the choices the printer's MCP offers, so its estimate (and Print) aren't refused", () => {
  const chosen = {
    destinationId: "p1s",
    quality: "fine",
    strength: "max",
    copies: 3,
    pauseBeforeLayers: [5],
  };
  const all = {
    quality: true,
    strength: true,
    copies: true,
    layerPauses: true,
  };
  assert.deepEqual(
    offeredChoices(chosen, {
      capabilities: all,
      sliced: false,
      savedCopies: false,
    }),
    chosen,
  );
  // An MCP without those choices: its own preset, and no copies unless some were saved (then exactly one).
  assert.deepEqual(
    offeredChoices(chosen, {
      capabilities: {},
      sliced: false,
      savedCopies: false,
    }),
    {
      destinationId: "p1s",
      quality: "standard",
      strength: "standard",
      copies: undefined,
      pauseBeforeLayers: [],
    },
  );
  assert.equal(
    offeredChoices(chosen, {
      capabilities: {},
      sliced: false,
      savedCopies: true,
    }).copies,
    1,
  );
  assert.equal(
    "copies" in
      estimateRequest(
        "o1",
        offeredChoices(chosen, {
          capabilities: {},
          sliced: false,
          savedCopies: false,
        }),
      ),
    false,
  );
  // A sliced plate keeps its own settings.
  assert.deepEqual(
    offeredChoices(chosen, {
      capabilities: all,
      sliced: true,
      savedCopies: false,
    }),
    {
      destinationId: "p1s",
      quality: "standard",
      strength: "standard",
      copies: 1,
      pauseBeforeLayers: [],
    },
  );
});

// David, Nov 5: "where did the 'start with these things' thing go". The starters follow the view, not how many
// projects there are: the Projects view lists them with or without projects.
test("Home lists the starters in the Projects view whatever projects exist", () => {
  assert.equal(startersShown({ search: "", filter: "all" }), true);
  assert.equal(startersShown({ search: "   ", filter: "all" }), true);
  assert.equal(startersShown({ search: "caliper", filter: "all" }), false);
  assert.equal(startersShown({ search: "", filter: "working" }), false);
  assert.equal(startersShown({ search: "", filter: "archived" }), false);
});

test("MCP row shows the printer’s checkout separately from the app copy", async () => {
  const { readFile } = await import("node:fs/promises");
  const { mcpUsageWords } = await import("../src/domain.ts");
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/contracts/fixtures/mcp-profile-copies.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    mcpUsageWords(fixture.uses[0]),
    "Bambu Lab P1S uses your copy at /home/ada/mcp-3D-printer-server (1.2.25).",
  );
  assert.equal(fixture.appCopy.version, "1.2.45");
});

test("an accepted MCP move explains that it is waiting for the print", async () => {
  const {readFile} = await import("node:fs/promises");
  const {mcpMoveNotice} = await import("../src/domain.ts");
  const reply = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-update-waiting.json", import.meta.url), "utf8"));
  assert.equal(mcpMoveNotice(reply), "Moves to Counterpart’s updated copy after the current print.");
});

test("a designer's file starts at its own settings, never the saved quality and strength (Nov 5)", () => {
  const settings = { printDefaults: { quality: "draft", strength: "strong", copies: 2 } };
  const designer = { settings, current: { model: "current/model.3mf", renders: [], ownSettings: true } } as unknown as Project;
  assert.deepEqual(startingChoices(designer), { copies: 2 });
  assert.equal(designerSettingsWords(designer, "standard", "standard"), "Prints with the designer’s settings saved in this file.");
  assert.equal(designerSettingsWords(designer, "fine", "standard"), "Changes the designer’s settings saved in this file.");
  const unknown = { settings, current: { model: "current/model.3mf", renders: [] } } as unknown as Project;
  assert.deepEqual(startingChoices(unknown), settings.printDefaults, "an MCP that doesn't say: the saved defaults, as before");
  assert.equal(designerSettingsWords(unknown, "standard", "standard"), undefined);
});
