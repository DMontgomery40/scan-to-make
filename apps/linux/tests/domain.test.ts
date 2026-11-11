import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canLocate, gallery, drawnColour, photoPicture, still } from "../src/gallery";
import {
  pageActions,
  projectPage,
  codeEngineRow,
  passEnding,
  stageMark,
  passHeading,
  sizeFields,
  sizesAnswer,
  sizesUnchanged,
  sizeSource,
  KNOWN_ASK_KINDS,
  rowWords,
  askAnswerable,
  sizesCarried,
  requestedChange,
  AFTER_PRINTING,
  didItFitQuestion,
  projectGroups,
  printerSummary,
  ReadOrder,
  estimateRequest,
  freezePlate,
  offeredChoices,
  printRequest,
  shownSlice,
  guardPlate,
  parseLayers,
  searchProject,
  searchSnippet,
  resolvedPrinter,
  projectThumbnail,
  words,
  startersShown,
  normalizeQuestion,
  validateAnswer,
  startingChoices,
  designerSettingsWords,
  slicerControls,
  obtainControl,
  obtainValue,
  addressField,
  canSelectPlate,
  printNeedsCheck,
  AUTO_UPDATE_LABEL,
  AUTO_UPDATE_WORDS,
  autoUpdatePatch,
  autoUpdateSwitch,
} from "../src/domain.ts";
import type { Project, ReconstructionReview } from "../src/types.ts";
import type { CodeEngineView } from "../src/domain.ts";
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
// David, Nov 10: "of ALL THE OPTIONS ... the photograph including everything in it is by far the worst".
test("a project's picture is the object alone on the stage, never a photo of the room", () => {
  const rendered = { ...project, plates: undefined, current: { model: "current/model.stl", renders: ["current/renders/overview.png"] } } as unknown as Project;
  assert.equal(projectThumbnail({ ...rendered, photos: ["bottle.jpg"], capture: ["0001.heic"] }), "current/renders/overview.png", "until the computer draws it: the render");
  assert.equal(projectThumbnail({ ...rendered, picture: "pictures/part-1.png" }), "pictures/part-1.png");
  assert.equal(projectThumbnail({ ...project, plates: undefined, photos: ["bottle.jpg"], capture: ["0001.heic"] } as unknown as Project), undefined, "the placeholder, never the room");
});

// PRD §5.4 Pictures: the same entries as CounterpartKit and Android, from the shared cases.
test("every client derives the same pictures from the shared gallery cases", () => {
  const doc = JSON.parse(readFileSync(new URL("../../../packages/contracts/fixtures/project-gallery.json", import.meta.url), "utf8"));
  assert.ok(doc.cases.length >= 8);
  for (const item of doc.cases) {
    const entries = gallery(item.project as Project);
    assert.deepEqual(entries.map((e) => e.id), item.entries.map((e: { id: string }) => e.id), item.name);
    if (item.photoPicture) assert.equal(photoPicture(item.project as Project), item.photoPicture, item.name);
    if (item.canLocate !== undefined) assert.equal(canLocate(item.project as Project), item.canLocate, item.name);
    entries.forEach((entry, index) => {
      const want = item.entries[index];
      assert.equal(entry.kind, want.kind, item.name);
      assert.equal(entry.label, want.label, item.name);
      assert.equal(entry.measures, want.measures, item.name);
      assert.equal(entry.colour, want.colour, item.name);
      assert.deepEqual(entry.sizeMm, want.sizeMm, item.name);
      assert.deepEqual(entry.photos ?? [], want.photos ?? [], item.name);
      if (want.still !== undefined) {
        const got = still(item.project as Project, entry);
        assert.equal(typeof got === "string" ? got : got.picture, want.still, `${item.name}: ${entry.id}'s stage`);
      }
      const drawing = "assembly" in entry.drawing
        ? { assembly: { part: entry.drawing.assembly.part, object: entry.drawing.assembly.object, seats: entry.drawing.assembly.seats.length } }
        : entry.drawing;
      assert.deepEqual(drawing, want.drawing, item.name);
    });
  }
  const many = doc.cases.find((c: { name: string }) => c.name.includes("six plates"));
  assert.equal(gallery(many.project).length, 6, "a designer's six plates: six labelled entries");
});

test("a finished print asks Did it fit? until it's answered, as the other clients do", () => {
  const done = {
    ...project,
    state: "printed",
    print: { monitor: { phase: "ended", endState: "done" } },
  } as unknown as Project;
  assert.equal(didItFitQuestion(done), "Did it fit?");
  assert.equal(didItFitQuestion({ ...done, kind: "published" }), "Did it come out right?");
  assert.equal(
    didItFitQuestion({ ...done, settings: { status: "printed", archived: false } }),
    "Did it fit?",
  );
  for (const status of ["works", "needs-changes", "not-printed"])
    assert.equal(didItFitQuestion({ ...done, settings: { status, archived: false } }), undefined, status);
  assert.equal(didItFitQuestion({ ...done, outcome: "works" }), undefined);
  // Accepted by the printer isn't finished; a cancelled print isn't asked about.
  assert.equal(didItFitQuestion({ ...done, print: { monitor: { phase: "watching" } } } as unknown as Project), undefined);
  assert.equal(didItFitQuestion({ ...done, print: { monitor: { phase: "ended", endState: "cancelled" } } } as unknown as Project), undefined);
  assert.equal(AFTER_PRINTING, "After printing: ");
});

test("sidebar failures need you, ready is a group rather than a selection", () => {
  const rows = ["ready", "failed", "needs-closeup", "printed"].map(
    (state, i) => ({ ...project, id: String(i), state }),
  );
  assert.deepEqual(
    projectGroups(rows).map((g) => [g.title, g.projects.map((p) => p.id)]),
    [
      ["Needs you", ["1", "2"]],
      ["Ready", ["0"]],
      ["Printed", ["3"]],
    ],
  );
  assert.equal(projectGroups([{ ...rows[1], archived: true }]).length, 0);
});

test("printer summary keeps the attention badge and active print with projects present", () => {
  const printers = [
    {
      id: "p1",
      name: "P1S",
      model: "Bambu Lab P1S",
      backend: "",
      state: "ready",
    },
    { id: "p2", name: "Desk", backend: "", state: "offline" },
  ];
  const rows = [
    { ...project, state: "printing", print: { destinationId: "p1" } },
  ];
  assert.deepEqual(printerSummary(printers, rows), {
    problems: 1,
    label: "Printers, 1 needs attention",
    status: "Bambu Lab P1S printing",
  });
  assert.equal(printerSummary([], rows).problems, 0);
  assert.equal(
    printerSummary(
      printers.map((p) => ({ ...p, state: "offline" })),
      rows,
    ).label,
    "Printers, 2 need attention",
  );
});

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
// David, Nov 6, on his six-plate rig: "i can't select which plate to print in the app i can see them but i can't click
// on them". Plate 1's start couldn't be confirmed; every plate stays choosable, on the project and in Print, and only
// the plate that may have started asks for the printer check.
test("after an unconfirmed start every plate stays choosable, and only its plate asks for a printer check", () => {
  // The shared fixture the companion's own tests check: David's rig after plate 1's start timed out.
  const rig = JSON.parse(
    readFileSync(new URL("../../../packages/contracts/fixtures/six-plate-unconfirmed.json", import.meta.url), "utf8"),
  ) as Record<"unconfirmed" | "switched" | "back" | "cancelled", Project>;
  assert.equal(canSelectPlate(rig.unconfirmed), true);
  assert.equal(printNeedsCheck(rig.unconfirmed), true);
  assert.equal(canSelectPlate(rig.switched), true);
  assert.equal(printNeedsCheck(rig.switched), false, "another plate prints without the check");
  assert.equal(printNeedsCheck(rig.back), true, "back on plate 1 it asks again");
  assert.equal(printNeedsCheck(rig.cancelled), false, "a cancelled send was never sent (Codex on #380)");
  assert.equal(canSelectPlate({ ...rig.switched, state: "printing" }), false);
  const choices = { destinationId: "p1s", quality: "standard", strength: "standard", pauseBeforeLayers: [] } as Parameters<typeof printRequest>[1];
  assert.equal(printRequest("p", choices, "sha", rig.back.plates![0].id, true).checked, true);
  assert.equal("checked" in printRequest("p", choices, "sha", rig.switched.plates![3].id, false), false);
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

test("Settings → Printers follow-up: two P1S profiles get Moves that read apart, in listed order; another client's update shows in its MCP's group", async () => {
  const { readFile } = await import("node:fs/promises");
  const { mcpMoves, mcpPackageIds, mcpUsageWords, mcpUpdateNotices } = await import("../src/domain.ts");
  const { packages } = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-printer-moves.json", import.meta.url), "utf8"));
  const titles = packages.flatMap((pkg: any) => mcpMoves(pkg).map((move) => move.title));
  assert.equal(new Set(titles).size, 2, "two P1S Moves never read the same");
  for (const pkg of packages) assert.deepEqual(mcpMoves(pkg).map((move) => move.mcpId), pkg.uses.filter((use: any) => use.canMove).map((use: any) => use.mcpId));
  assert.match(mcpUsageWords(packages[0].uses[0]), /older than Counterpart’s copy \(1\.1\.69\)/);
  // A companion before Nov 6 (no moves, no words): listed order, not sorted ids, each naming its copy.
  const older = {package: "bambu-printer-mcp", label: "bambu-printer-mcp", description: "", installed: true, appMcpId: "mcp-a", installs: [], uses: [
    {destinationId: "z", printer: "Bambu Lab P1S", mcpId: "mcp-f", kind: "app", path: "/x/printers/bambu-1.1.46", version: "1.1.65", canMove: true},
    {destinationId: "a", printer: "Bambu Lab P1S", mcpId: "mcp-0", kind: "checkout", path: "/x/bambu-printer-mcp", canMove: true}]};
  assert.deepEqual(mcpMoves(older).map((move) => move.mcpId), ["mcp-f", "mcp-0"]);
  assert.notEqual(mcpMoves(older)[0]!.title, mcpMoves(older)[1]!.title);
  // An mcp.update.* event from any client is a notice under its package (the Move's install and Counterpart's copy).
  const id = packages[1].moves[0].mcpId;
  const notices = mcpUpdateNotices({}, [{type: "mcp.update.started", title: "Updating mcp-3D-printer-server", body: "1.2.25 to 1.2.50", data: {mcpId: id}}]);
  assert.ok(mcpPackageIds(packages[1]).includes(id) && notices[id]);
  assert.ok(mcpPackageIds(packages[1]).includes(packages[1].appMcpId));
  assert.ok(!mcpPackageIds(packages[0]).includes(id), "never under the other MCP");
});

test("an accepted MCP move explains that it waits for Counterpart's own work", async () => {
  const {readFile} = await import("node:fs/promises");
  const {mcpMoveNotice} = await import("../src/domain.ts");
  const reply = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-update-waiting.json", import.meta.url), "utf8"));
  assert.equal(mcpMoveNotice(reply), "Moves to Counterpart’s updated copy as soon as Counterpart finishes its work on this printer.");
});

// Nov 6, "mcps won't update they just spin forever": Update answered `waiting`, and Linux showed the bare word. Every
// answer is a sentence.
test("Update's answer is a sentence, and waiting says what for", async () => {
  const {readFile} = await import("node:fs/promises");
  const {mcpUpdateNotice} = await import("../src/domain.ts");
  const waiting = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-update-waiting.json", import.meta.url), "utf8"));
  assert.equal(mcpUpdateNotice(waiting), "Updates as soon as Counterpart finishes its work on this printer.");
  assert.equal(mcpUpdateNotice({update: {state: "started", toVersion: "1.1.76"}}), "Updating to 1.1.76…");
  assert.equal(mcpUpdateNotice({update: {state: "current"}}), "Already the newest version.");
  assert.equal(mcpUpdateNotice({update: {state: "unresolved", found: "It runs over SSH."}}), "It runs over SSH.");
  assert.equal(mcpUpdateNotice({state: "waiting"}), "Updates as soon as Counterpart finishes its work on this printer.", "an older companion's flat answer");
  for (const state of ["waiting", "started", "current", "unresolved"]) assert.notEqual(mcpUpdateNotice({update: {state}}), state);
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

test("a multi-colour model's rows: the MCP's proposal, its note, mixed feeds, and the spools Estimate and Print send", async () => {
  const { proposedSlots, chosenSpools, mixesFeeds, partNote, spoolTitle } = await import("../src/domain.ts");
  const tray = (slot: number, label: string, name: string, colour: string, material: string, feed: string) =>
    ({ slot, label, name, colour, material, filamentId: "GFA00", destinationId: "p1s", feed });
  const mapping = {
    filaments: [
      { index: 1, name: "body", colour: "#000000", material: "PLA", slot: 0, verdict: "same-colour" },
      { index: 2, name: "markings", colour: "#FFFFFF", material: "PLA", slot: 1, verdict: "closest",
        note: "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic." },
    ],
    trays: [tray(0, "A1", "Black PLA Basic", "#000000", "PLA", "ams"), tray(1, "A2", "Sunflower Yellow PLA Basic", "#FEC600", "PLA", "ams"),
      tray(2, "A3", "Translucent Teal PETG Translucent", "#77EDD7", "PETG", "ams"), tray(254, "External", "White PLA", "#FFFFFF", "PLA", "external")],
    modelVersion: "v1",
  };
  const slots = proposedSlots(mapping);
  assert.deepEqual(slots, { 1: 0, 2: 1 });
  assert.equal(partNote(mapping, mapping.filaments[1], slots), "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.");
  assert.equal(partNote(mapping, mapping.filaments[1], { 1: 0, 2: 2 }), "Prints in PETG, not PLA.", "the person's own choice, said plainly");
  assert.equal(mixesFeeds(mapping, { 1: 0, 2: 254 }), true);
  assert.equal(mixesFeeds(mapping, slots), false);
  assert.equal(spoolTitle(mapping.trays[1]), "A2 · Sunflower Yellow PLA Basic");
  assert.equal(chosenSpools(mapping, { 1: 0 }), undefined, "every part needs a spool");
  const spools = chosenSpools(mapping, { 1: 254, 2: 254 })!;
  const request = estimateRequest("p", { destinationId: "p1s", quality: "standard", strength: "standard", pauseBeforeLayers: [], spools, modelVersion: "v1" });
  assert.ok("filaments" in request);
  assert.deepEqual(request.filaments.map((f) => f.slot), [254, 254]);
  assert.equal("filamentsModelVersion" in request && request.filamentsModelVersion, "v1");
  assert.equal("filament" in request, false, "per-part spools, never one spool for the whole model");
});

test("software results retain a waiting move when another MCP updates", async () => {
  const {readFile} = await import("node:fs/promises");
  const {mcpUpdateNotices} = await import("../src/domain.ts");
  const events = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-copy-update-events.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../../../packages/contracts/fixtures/mcp-profile-copies.json", import.meta.url), "utf8"));
  const move = events[1];
  const update = {...events[2], data: {...events[2].data, mcpId: pkg.appMcpId}};
  const completed = mcpUpdateNotices({}, [move]);
  const later = mcpUpdateNotices(completed, [update]);
  assert.equal(later[move.data.mcpId], `${move.title} ${move.body}`);
  assert.equal(later[update.data.mcpId], `${update.title} ${update.body}`);
  assert.deepEqual(mcpUpdateNotices({}, [move, update]), later);
});

test("Add a printer offers the chosen MCP's own slicer choice and paths, and sends only a changed slicer (Codex review on #346)", () => {
  // What mcp-3d-printer-server 1.2.50 really declares (counterpart_setup_fields, captured with no slicer installed).
  const fields = JSON.parse(readFileSync(new URL("../../../services/companion/tests/fixtures/setup-fields-mcp-3d-printer-server-1.2.50.json", import.meta.url), "utf8"));
  const options = { types: [], models: {}, slicer: { "mcp-3d-printer-server": fields.slicer } };
  const controls = slicerControls(options, "mcp-3d-printer-server");
  assert.ok(controls, "the Slicer section is reachable for an MCP that declares one");
  assert.equal(controls.choice?.env, "SLICER_TYPE");
  assert.deepEqual(controls.choice?.choices?.map((c) => c.value), fields.slicer.fields[0].choices.map((c: { value: string }) => c.value));
  assert.deepEqual(controls.paths.map((p) => [p.key, p.field.required, p.placeholder]), [["slicerPath", true, "/opt/nowhere/bambu-studio"]]);
  // The MCP's own slicer shows as chosen and sends nothing; another one is sent, so SLICER_TYPE and SLICER_PATH agree.
  assert.equal(controls.selected({ slicer: "" }), "prusaslicer");
  assert.equal(controls.choose("prusaslicer"), "");
  assert.equal(controls.choose("orcaslicer"), "orcaslicer");
  assert.equal(controls.selected({ slicer: "orcaslicer" }), "orcaslicer");
  // An MCP that declares no slicer settings shows no Slicer section.
  assert.equal(slicerControls(options, "bambu-printer-mcp"), undefined);
  assert.equal(slicerControls(undefined, "mcp-3d-printer-server"), undefined);
});

test("Add a printer offers the MCP's own approval button for its key, and the approved key fills the form (Nov 6)", async () => {
  // The options `printers.discover` returns from mcp-3d-printer-server 1.2.53's counterpart_setup_fields.
  const options = {
    types: [
      { printerType: "bambu", label: "Bambu Lab", backends: ["bambu-printer-mcp"], serial: true, secret: { label: "Access code", required: true } },
      {
        printerType: "octoprint", label: "OctoPrint", backends: ["mcp-3d-printer-server"], serial: false,
        secret: { label: "API key", required: true, obtain: { label: "Approve in OctoPrint", hint: "OctoPrint asks you to allow this app in its web page", backends: ["mcp-3d-printer-server"] } },
      },
    ],
    models: {},
  };
  assert.deepEqual(obtainControl(options, { printerType: "octoprint", backend: "mcp-3d-printer-server" }),
    { field: "secret", label: "Approve in OctoPrint", hint: "OctoPrint asks you to allow this app in its web page" });
  assert.equal(obtainControl(options, { printerType: "bambu", backend: "bambu-printer-mcp" }), undefined, "only where the MCP declares it");
  assert.equal(obtainControl(options, { printerType: "octoprint", backend: "bambu-printer-mcp" }), undefined, "only for the MCP that declares it");

  const sent: object[] = [];
  const answers = [
    { session: "s1", status: "pending", message: "Click Allow in OctoPrint.", approveUrl: "http://octopi.local/plugin/appkeys/auth/t" },
    { session: "s1", status: "pending", message: "Click Allow in OctoPrint.", approveUrl: "http://octopi.local/plugin/appkeys/auth/t" },
    { status: "approved", message: "Allowed.", value: "KEY" },
  ];
  const fake = async <T,>(method: string, params: object): Promise<T> => {
    assert.equal(method, "printers.obtain");
    sent.push(params);
    return answers.shift() as T;
  };
  const steps: string[] = [];
  const last = await obtainValue(fake, { backend: "mcp-3d-printer-server", printerType: "octoprint", host: " octopi.local ", port: "", secret: "" },
    (step) => steps.push(step.status), () => false);
  assert.deepEqual(last, { status: "approved", message: "Allowed.", value: "KEY" });
  assert.deepEqual(steps, ["pending", "pending", "approved"]);
  assert.deepEqual(sent[0], { backend: "mcp-3d-printer-server", printerType: "octoprint", host: "octopi.local", field: "secret" });
  assert.deepEqual(sent[2], { ...sent[0], session: "s1" });

  // Closing the sheet stops asking.
  let asked = 0;
  await obtainValue(async <T,>() => { asked++; return { session: "s2", status: "pending", message: "Click Allow." } as T; },
    { backend: "mcp-3d-printer-server", printerType: "octoprint", host: "octopi.local" }, () => {}, () => asked >= 1);
  assert.equal(asked, 1);
});

test("Add a printer's address offers a web address only where the MCP's field takes one (mcp-3d-printer-server 1.2.55)", () => {
  const options = {
    types: [
      { printerType: "octoprint", label: "OctoPrint", backends: ["mcp-3d-printer-server"], serial: false,
        address: { hint: "OctoPrint's address (octopi.local or an IP address), or its full URL for HTTPS or a sub-path", url: true } },
      { printerType: "klipper", label: "Klipper (Moonraker)", backends: ["mcp-3d-printer-server"], serial: false,
        address: { hint: "The printer's IP address or host name" } },
    ],
    models: {},
  };
  assert.match(addressField(options, "octoprint").placeholder, /https:/);
  assert.match(addressField(options, "octoprint").hint!, /sub-path/);
  assert.doesNotMatch(addressField(options, "klipper").placeholder, /https:/);
  assert.equal(addressField(options, "klipper").hint, "The printer's IP address or host name");
  assert.doesNotMatch(addressField(undefined, "octoprint").placeholder, /https:/);
});

test("while the printer MCP sends the file, a project shows the companion's percentage", () => {
  // counterpart/1 upload progress, as the companion writes it to Project.progress (Mac, iPhone, iPad and Android show the same).
  assert.equal(words({ id: "x", state: "printing", progress: "Sending to the printer… 62%" } as unknown as Project), "Sending to the printer… 62%");
});


test("all three shared limit reasons survive project words with projects present", () => {
  const rows = JSON.parse(readFileSync(new URL("../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/capped-projects.json", import.meta.url), "utf8"));
  const reasons: Record<string, string> = {
    "limit-inactivity": "Stopped after 10 minutes without worker activity",
    "limit-absolute": "Stopped at the absolute time limit of 2 hours",
    "limit-tool-calls": "Stopped at the 120 tool-call limit",
  };
  const stopped = rows.filter((row: {name: string}) => row.name.startsWith("limit-"));
  assert.deepEqual(stopped.map((row: {name: string}) => row.name).sort(), Object.keys(reasons).sort());
  const projects = [project, ...stopped.map((row: {expected: Project}) => row.expected)];
  assert.equal(projects.length, 4);
  for (const row of stopped) {
    // The pass's own line is the companion's words too, never the wire status ("capped").
    assert.equal(passHeading(row.expected.passes.at(-1), 0), `Pass 1 · ${reasons[row.name]}`);
    assert.equal(passHeading({}, 1), "Pass 2 · Working", "a running pass");
    assert.equal(words(row.expected), `${reasons[row.name]}. Try again or review the saved checkpoint.`);
    assert.equal(row.expected.canRetryCleanup, true);
  }
});

// PRD §8.9, §6.1: the code design engine's row is in Settings → Model access → Design engine, from the companion's
// cad.status (the printer MCP's cad_status), with Set Up (cad.setup) when the companion offers it.
test("the code design engine row is reachable in Settings and shows the companion's words and Set Up", () => {
  const settings = readFileSync(new URL("../src/Settings.tsx", import.meta.url), "utf8");
  const models = settings.slice(settings.indexOf("<h3>Design engine</h3>"));
  assert.ok(models.indexOf("<CodeEngine />") > 0 && models.indexOf("<CodeEngine />") < models.indexOf("<Blender />"), "listed first under Design engine");
  assert.match(settings, /call<\{ cad: CodeEngineView \}>\("cad\.status"\)/);
  assert.match(settings, /call<\{ cad: CodeEngineView \}>\("cad\.setup"\)/);
  const tauri = readFileSync(new URL("../src-tauri/src/protocol.rs", import.meta.url), "utf8");
  assert.match(tauri, /"cad\.status"/); assert.match(tauri, /"cad\.setup"/);
  assert.deepEqual(codeEngineRow({ state: "not-set-up", message: "Not set up yet.", canSetUp: true }), { message: "Not set up yet.", action: "Set Up", working: false });
  // Sizes from the MCP's storage fields, before and after Set Up; a refusal in the MCP's words, its code never read.
  assert.equal(codeEngineRow({ state: "not-set-up", message: "Not set up yet.", canSetUp: true, size: "Set Up downloads about 367 MB and uses about 1.6 GB on this computer." }).size,
    "Set Up downloads about 367 MB and uses about 1.6 GB on this computer.");
  assert.equal(codeEngineRow({ state: "ready", message: "Ready.", canSetUp: true, size: "Uses 1.4 GB on this computer." }).size, "Uses 1.4 GB on this computer.");
  assert.deepEqual(codeEngineRow({ state: "not-set-up", message: "Not set up yet.", canSetUp: true,
    result: { ok: false, message: "The MCP's sentence.", suggestion: "The MCP's suggestion.", refusal: { code: "cad-uv-missing" } } as CodeEngineView["result"] }).result,
    { ok: false, message: "The MCP's sentence.", suggestion: "The MCP's suggestion." });
  assert.match(settings, /\{row\.size && <p>\{row\.size\}<\/p>\}/, "the size line is shown");
  assert.deepEqual(codeEngineRow({ state: "ready", message: "Ready. New designs and scan cleanups use it.", canSetUp: true, result: { ok: true, message: "CAD is ready." } }),
    { message: "Ready. New designs and scan cleanups use it.", action: "Set Up Again", working: false, result: { ok: true, message: "CAD is ready." } });
  assert.deepEqual(codeEngineRow({ state: "setting-up", message: "Setting up… 12 s so far.", seconds: 12, canSetUp: false }), { message: "Setting up… 12 s so far.", working: true });
  assert.deepEqual(codeEngineRow({ state: "unavailable", message: "Update mcp-3D-printer-server in Settings → Printers to use its code design engine.", canSetUp: false }),
    { message: "Update mcp-3D-printer-server in Settings → Printers to use its code design engine.", working: false });
  assert.deepEqual(codeEngineRow(undefined), { message: "Checking…", working: true });
});

// Q9, PRD §6.1: "Keep printer software up to date" is in Settings → Printers → Printer tools, on unless turned off,
// and writes the companion's own setting (general.autoUpdateMcps) through settings.set.
test("Keep printer software up to date is reachable in Settings → Printers and reads and writes the companion's setting", () => {
  const settings = readFileSync(new URL("../src/Settings.tsx", import.meta.url), "utf8");
  const printers = settings.slice(settings.indexOf("function Printers("));
  const tools = printers.slice(printers.indexOf("<h3>Printer tools</h3>"));
  assert.ok(tools.indexOf("{AUTO_UPDATE_LABEL}") > 0, "under Printer tools");
  assert.ok(tools.indexOf("{AUTO_UPDATE_LABEL}") < tools.indexOf("{packages.map("), "above the MCPs and their Update buttons");
  assert.ok(tools.indexOf("{AUTO_UPDATE_WORDS}") > 0, "with its one sentence");
  // One set of words on every layout: the Swift apps' (CounterpartKit) and Android's copies are these, exactly.
  assert.equal(AUTO_UPDATE_LABEL, "Keep printer software up to date");
  assert.equal(AUTO_UPDATE_WORDS, "Counterpart updates its printer software by itself when nothing is printing or being designed, and tells you afterwards.");
  const swift = readFileSync(new URL("../../../packages/CounterpartKit/Sources/CounterpartKit/Settings/SettingsSchema.swift", import.meta.url), "utf8");
  const kotlin = readFileSync(new URL("../../../android/app/src/main/java/com/scantomake/counterpart/ui/PrinterSettings.kt", import.meta.url), "utf8");
  assert.ok(swift.includes(`label: "${AUTO_UPDATE_LABEL}"`) && swift.includes(`footer: "${AUTO_UPDATE_WORDS}"`), "iPhone, iPad and Mac");
  assert.ok(kotlin.includes(`AUTO_UPDATE_MCPS_LABEL = "${AUTO_UPDATE_LABEL}"`) && kotlin.includes(`AUTO_UPDATE_MCPS_WORDS = "${AUTO_UPDATE_WORDS}"`), "Android");
  assert.match(printers, /call<\{ settings: CompanionSettings \}>\("settings\.get"\)/);
  assert.match(printers, /call<\{ settings: CompanionSettings \}>\("settings\.set", autoUpdatePatch\(e\.target\.checked\)\)/);
  // On for a companion that says nothing else; off only when turned off; hidden for a companion without the setting.
  assert.deepEqual(autoUpdateSwitch({ milestones: "50", general: { autoUpdateMcps: true } }), { shown: true, on: true });
  assert.deepEqual(autoUpdateSwitch({ milestones: "50", general: { autoUpdateMcps: false } }), { shown: true, on: false });
  assert.deepEqual(autoUpdateSwitch({ milestones: "50", general: {} }), { shown: false, on: true });
  assert.deepEqual(autoUpdateSwitch(undefined), { shown: false, on: true });
  assert.deepEqual(autoUpdatePatch(false), { general: { autoUpdateMcps: false } });
  const tauri = readFileSync(new URL("../src-tauri/src/protocol.rs", import.meta.url), "utf8");
  assert.match(tauri, /"settings\.get"/); assert.match(tauri, /"settings\.set"/);
});

test("David's Nov 9 bottle: the question's caption is true for any question, and the scan is five frames and the count", async () => {
  const { askCaption, clampRegion, scanSample, scanWords } = await import("../src/domain");
  const region = { x: 0.42, y: 0.3, width: 0.28, height: 0.34 };
  assert.equal(askCaption({ photo: "asks/a.jpg", region }), "The outlined part is what this question is about.");
  assert.equal(askCaption({ photo: "asks/a.jpg" }), "The picture that goes with this question.");
  assert.equal(askCaption(undefined), "Your project’s picture. No picture came with this question.");
  for (const caption of [askCaption({ photo: "a", region }), askCaption(undefined)]) assert.doesNotMatch(caption, /can.t see/i);
  assert.equal(clampRegion({ x: 1.2, y: 0, width: 0.3, height: 0.3 }), undefined);
  assert.deepEqual(scanSample(130), [0, 32, 65, 97, 129], "the same frames as the iPhone, Mac and Android");
  assert.deepEqual(scanSample(3), [0, 1, 2]);
  assert.equal(scanWords(130), "130 photos");
});

test("a search result whose title lacks the words says where it matched (first look U10)", () => {
  const hanger = {
    ...project,
    title: "AirPods Max desk hanger",
    messages: [
      {
        id: "m",
        text: "okay the main holder is actually terrible cause the ridge of teh rails holds it too high and it wobbles when I take the headphones off",
        atMs: 2,
        photos: [],
      },
    ],
  };
  assert.equal(searchProject(hanger, "holder"), true);
  const snippet = searchSnippet(hanger, "holder");
  assert.ok(snippet);
  assert.match(snippet.text, /main holder is actually terrible/);
  assert.ok(snippet.text.length < 120, snippet.text);
  assert.equal(snippet.text.slice(...snippet.match).toLowerCase(), "holder");
  assert.equal(searchSnippet(hanger, "desk"), undefined, "the title says it");
  assert.equal(searchSnippet(hanger, "  "), undefined);
});

// The stage stays dark for every colour (David, Nov 11): a dark part is floored in its material, the same
// values as CounterpartKit StageMaterial and the Mac's still pictures, from the shared fixture.
test("every filament colour stays readable on the dark stage", () => {
  const doc = JSON.parse(readFileSync(new URL("../../../packages/contracts/fixtures/project-gallery.json", import.meta.url), "utf8"));
  for (const [spool, want] of Object.entries<string>(doc.stage.drawnColours)) assert.equal(drawnColour(spool), want, spool);
  assert.equal(drawnColour("#000000"), "#333435", "a true black filament is drawn as charcoal, not a silhouette");
  assert.equal(drawnColour("#5B6579"), "#5B6579", "blue grey is already above the floor");
});

test("a pass that stopped to ask or stopped short never reads as all ticks", () => {
  const stages = [{ id: "preparing", words: "Getting ready", endedAtMs: 2 }, { id: "working", words: "Designing it", endedAtMs: 3 }];
  const marks = (status: string | undefined, endedAtMs: number | undefined = 3) => stages.map((_, i) => stageMark({ endedAtMs, status, stages }, i));
  assert.deepEqual(marks("done"), ["✓", "✓"]);
  assert.deepEqual(marks("unchanged"), ["✓", "✓"]);
  assert.deepEqual(marks("needs_closeup"), ["✓", "?"]);
  assert.deepEqual(marks("needs_file"), ["✓", "?"]);
  for (const status of ["capped", "failed", "interrupted"]) assert.deepEqual(marks(status), ["✓", "✕"], status);
  assert.equal(passEnding({ status: "failed" }), undefined, "a running pass has not ended");
  assert.deepEqual(stages.map((_, i) => stageMark({ stages: [stages[0], { id: "working", words: "Designing it" }] }, i)), ["✓", "◌"]);
});

test("a size question is number fields with the companion's labels, prefilled, with projects present", () => {
  const ask = {
    kind: "sizes",
    sizes: [
      { id: "size-1", label: "width at the widest point", mm: 64, from: "scan" },
      { id: "size-2", label: "width at the waist", mm: 53.5, from: "scan" },
      { id: "size-3", label: "height to the cap tip", mm: 107, from: "published" },
    ],
  };
  const fields = sizeFields(ask)!;
  assert.deepEqual(fields.map((f) => [f.label, f.text]), [["width at the widest point", "64"], ["width at the waist", "53.5"], ["height to the cap tip", "107"]]);
  assert.equal(sizesUnchanged(fields), true);
  assert.deepEqual(sizesAnswer(fields), [{ id: "size-1", mm: 64 }, { id: "size-2", mm: 53.5 }, { id: "size-3", mm: 107 }]);
  // A correction with a comma, and a size the person doesn't know left out (never sent as confirmed).
  const edited = fields.map((f, i) => (i === 0 ? { ...f, text: " 63,2 " } : i === 2 ? { ...f, text: "" } : f));
  assert.equal(sizesUnchanged(edited), false);
  assert.deepEqual(sizesAnswer(edited), [{ id: "size-1", mm: 63.2 }, { id: "size-2", mm: 53.5 }]);
  // Nothing is sent while a field isn't a number, or all are blank.
  for (const bad of ["about 60", "0", "-4", "10001", "6 3", "1e3"]) assert.equal(sizesAnswer(fields.map((f, i) => (i === 0 ? { ...f, text: bad } : f))), undefined, bad);
  assert.equal(sizesAnswer(fields.map((f) => ({ ...f, text: " " }))), undefined);
  // Only a sizes question with sizes is one; every other kind keeps its own card.
  // The companion's number can be finer than the field shows; untouched, that is still Confirm.
  const fine = sizeFields({ kind: "sizes", sizes: [{ id: "a", label: "width", mm: 68.412, from: "scan" }, { id: "b", label: "waist", mm: 53.4567, from: "scan" }] })!;
  assert.deepEqual(fine.map((f) => f.text), ["68.41", "53.46"]);
  assert.equal(sizesUnchanged(fine), true);
  assert.deepEqual(sizesAnswer(fine), [{ id: "a", mm: 68.41 }, { id: "b", mm: 53.46 }]);
  assert.equal(sizesUnchanged(fine.map((f) => (f.id === "a" ? { ...f, text: "68.42" } : f))), false);
  assert.equal(sizeFields({ kind: "closeup", sizes: ask.sizes }), undefined);
  assert.equal(sizeFields({ kind: "sizes", sizes: [] }), undefined);
  assert.equal(sizeFields(undefined), undefined);
  assert.equal(sizeSource("published"), "from the maker");
  assert.equal(sizeSource("scan"), "from your scan");
  assert.deepEqual(KNOWN_ASK_KINDS, ["closeup", "file", "choice", "region", "scale", "sizes"]);
  // The same forms on every client (F8): digits with at most one decimal part.
  const typed = (text: string) => sizesAnswer([{ ...fields[0], text }])?.[0].mm;
  for (const good of ["64", "53.5", " 53,25 ", "0.5", "10000"]) assert.notEqual(typed(good), undefined, good);
  for (const bad of ["1e3", ".5", "5.", "5.5.5", "+5", "-4", "0", "10001", "6 3", "about 60", "٥"]) assert.equal(typed(bad), undefined, bad);
  // Train #499 review, F3: another answer from the card carries the numbers as they stand, or does not go.
  assert.deepEqual(sizesCarried(fields), sizesAnswer(fields));
  assert.deepEqual(sizesCarried(edited), [{ id: "size-1", mm: 63.2 }, { id: "size-2", mm: 53.5 }]);
  assert.equal(sizesCarried(fields.map((f, i) => (i === 1 ? { ...f, text: "about 53" } : f))), "invalid");
  assert.equal(sizesCarried(fields.map((f) => ({ ...f, text: " " }))), "none");
  // F6: a kind this build doesn't know offers no answer; no kind is an older companion's question.
  for (const kind of KNOWN_ASK_KINDS) assert.equal(askAnswerable({ kind }), true, kind);
  assert.equal(askAnswerable({}), true);
  assert.equal(askAnswerable({ kind: "colour" }), false);
});

test("an ended pass from an older companion is worded from its status, never headed Working", () => {
  // Train #499 review, F7: with no `words` every ended pass on Linux read "Pass n · Working".
  assert.equal(passHeading({ endedAtMs: 2, status: "done" }, 0), "Pass 1 · Finished");
  assert.equal(passHeading({ endedAtMs: 2 }, 0), "Pass 1 · Finished");
  assert.equal(passHeading({ endedAtMs: 2, status: "needs_closeup" }, 1), "Pass 2 · Asked you a question");
  assert.equal(passHeading({ endedAtMs: 2, status: "interrupted" }, 0), "Pass 1 · Stopped when Counterpart restarted");
  assert.equal(passHeading({ endedAtMs: 2, status: "needs_file" }, 0), "Pass 1 · Needs File");
  assert.equal(passHeading({ endedAtMs: 2, status: "failed", words: "Stopped before it finished" }, 0), "Pass 1 · Stopped before it finished");
  assert.equal(passHeading({ status: "failed" }, 0), "Pass 1 · Working", "not ended yet");
});

test("Your change is the person's own note, for every trigger the companion writes", () => {
  // Train #499 review, F5: Linux showed every pass's note, including the text the companion composes for an answer.
  const shown: [string | undefined, boolean][] = [["changes", true], ["late-photos", true], [undefined, true], ["ask-answer", false], ["new", false], ["something-later", false]];
  for (const [trigger, yes] of shown) assert.equal(requestedChange({ note: " see the photos ", trigger }), yes ? "see the photos" : undefined, String(trigger));
  assert.equal(requestedChange({ trigger: "changes" }), undefined);
  assert.equal(requestedChange({ note: "  ", trigger: "changes" }), undefined);
});

test("a row under its phase heading shows the companion's detail, never the heading again, with projects present", () => {
  const asking = { ...project, id: "a", state: "needs-closeup", status: { phase: "needs-you", tint: "orange", text: "Needs you · Can you confirm these sizes?", detail: "Can you confirm these sizes?" } } as Project;
  const ready = { ...project, id: "b", state: "ready", status: { phase: "ready", tint: "accent", text: "Ready to print · 68.4 × 34.6 × 149.2 mm", detail: "68.4 × 34.6 × 149.2 mm" } } as Project;
  const failed = { ...project, id: "c", state: "failed", status: { phase: "failed", tint: "red", text: "The printer stopped." } } as Project;
  assert.equal(rowWords(asking), "Can you confirm these sizes?");
  assert.equal(rowWords(ready), "68.4 × 34.6 × 149.2 mm");
  assert.equal(rowWords(failed), "The printer stopped.", "no detail: the line as it is");
  for (const p of [asking, ready]) assert.doesNotMatch(rowWords(p), /^(Needs you|Ready to print)/);
});

test("every project state has its one main action, as on every layout (main-actions.json)", () => {
  const doc = JSON.parse(readFileSync(new URL("../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/main-actions.json", import.meta.url), "utf8"));
  const numbers: number[] = doc.rows.map((row: { row: number }) => row.row);
  assert.deepEqual([...new Set(numbers)].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  for (const row of doc.rows) {
    const page = pageActions({ title: "", ...row.project } as Project, row.sending === true, row.projectSettings !== false);
    assert.equal(page.main ?? null, row.expected.main, `${row.name}: main`);
    assert.deepEqual(page.others, row.expected.others, `${row.name}: others`);
    assert.equal(page.printWords ?? null, row.expected.printWords, `${row.name}: what printing is called`);
    assert.equal(page.printPlace ?? null, row.expected.printPlace, `${row.name}: where printing goes`);
    assert.equal(page.printNote ?? null, row.expected.printNote, `${row.name}: what would be printed`);
    // The rule: an action once, and Print never both the lead and listed.
    assert.equal(new Set(page.others).size, page.others.length, row.name);
    assert.equal(page.main === "print" && page.others.some((a) => a.startsWith("print")), false, row.name);
  }
});

test("the page reads what the companion keeps: no Did it fit? without projectSettings (review of #527 part 4, S1)", () => {
  const doc = JSON.parse(readFileSync(new URL("../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/main-actions.json", import.meta.url), "utf8"));
  const row = doc.rows.find((r: { name: string }) => r.name === "printed-older-mac");
  const printed = { title: "", ...row.project } as Project;
  for (const capabilities of [undefined, {}, { projectSettings: false }]) {
    const { page, fit } = projectPage(printed, capabilities);
    assert.equal(page.main, "print", `${JSON.stringify(capabilities)}: Print leads`);
    assert.equal(fit, undefined, `${JSON.stringify(capabilities)}: no Did it fit? the companion can't keep`);
  }
  const { page, fit } = projectPage(printed, { projectSettings: true });
  assert.equal(page.main, "itWorks");
  assert.ok(fit, "a companion that keeps the answer asks");
});

test("search reasons survive a project without a title, and never cut an emoji in half (review F5)", () => {
  const untitled = { ...project, title: undefined, instructions: "A hook for the stroller handle", messages: [] } as unknown as Project;
  const reason = searchSnippet(untitled, "stroller");
  assert.ok(reason, "the instructions are still searched for the reason");
  assert.match(reason.text, /stroller handle/);
  // A long note with emoji right where the cut lands, and no spaces near it.
  const emoji = "🙂".repeat(40);
  const noisy = { ...project, title: "Clip", messages: [{ id: "m", text: `${emoji}holder${emoji}`, atMs: 1, photos: [] }] } as Project;
  const cut = searchSnippet(noisy, "holder");
  assert.ok(cut);
  assert.equal(cut.text.slice(...cut.match), "holder");
  assert.doesNotMatch(cut.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half of a surrogate pair");
});

test("a project's printer saved under its other MCP's id is still that printer (review F2)", () => {
  const printers = [{ id: "current", name: "P1S", mcps: [{ backend: "bambu-printer-mcp", destinationId: "current" }, { backend: "mcp-3d-printer-server", destinationId: "mcp-1a2b" }] }];
  assert.equal(resolvedPrinter(printers, "mcp-1a2b")?.name, "P1S");
  assert.equal(resolvedPrinter(printers, "current")?.name, "P1S");
  assert.equal(resolvedPrinter(printers, "gone"), undefined);
  assert.equal(resolvedPrinter(printers, undefined), undefined);
});

test("a project's printer saved under one of the catalog's aliases is that printer, as the Mac resolves it (S4)", () => {
  const printers = [{ id: "winner", name: "Printer", aliases: ["old-duplicate", "previous-mcp"] }, { id: "other", name: "Printer" }];
  assert.equal(resolvedPrinter(printers, "old-duplicate")?.id, "winner");
  assert.equal(resolvedPrinter(printers, "previous-mcp")?.id, "winner");
  assert.equal(resolvedPrinter(printers, "other")?.id, "other");
  assert.equal(resolvedPrinter(printers, "unknown"), undefined);
  assert.equal(resolvedPrinter(printers, "Printer"), undefined, "a matching display name is not identity evidence");
});

