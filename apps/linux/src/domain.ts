import type {
  Estimate,
  Field,
  Filament,
  PrintOptions,
  Project,
  Printer,
  Question,
  RawQuestion,
  SetupOptions,
  ReconstructionAnswer,
  ReconstructionComponent,
  ReconstructionReview,
  ReconstructionSelection,
  Vec3,
} from "./types";
/** Issue tickets before reads AND mutations. Late reads cannot roll the UI back. */
export class ReadOrder {
  private issued = 0;
  private accepted = 0;
  begin() {
    return ++this.issued;
  }
  invalidate() {
    this.accepted = ++this.issued;
  }
  accept(ticket: number) {
    if (ticket < this.accepted) return false;
    this.accepted = ticket;
    return true;
  }
}
export function freezePlate(project: Project) {
  return project.plates?.find((p) => p.selected)?.id;
}
export function guardPlate(project: Project, frozen: string | undefined) {
  if (freezePlate(project) !== frozen)
    throw new Error(
      "The selected plate changed on another device. Close Print and review the plate again.",
    );
  if (project.kind === "published" && !frozen)
    throw new Error("Choose a plate before printing.");
}
/**
 * Whether Home lists the starters (PRD §5.11). They follow the view, never the project count: on the Mac and iPad
 * they once showed only with no projects or nothing selected, and David asked where they went (Nov 5). The Projects
 * view lists them under the grid; a search or the In progress and Archive views show only projects.
 */
export function startersShown(view: { search: string; filter: string }) {
  return view.search.trim() === "" && view.filter === "all";
}

/** The project's picture: the real thing first (a photo or scan frame), else its render or designer thumbnail. */
export function projectThumbnail(p: Project): string | undefined {
  if (p.photos[0]) return `photos/${p.photos[0]}`;
  if (p.capture?.[0]) return `capture/${p.capture[0]}`;
  return p.current?.renders[0] ?? p.credit?.thumbnail;
}

/** What Needs Changes puts before the person's words, as on the iPhone, iPad, Android and Mac (PRD §5.4). */
export const AFTER_PRINTING = "After printing: ";

/**
 * "Did it fit?" (PRD §5.4) on a project whose print the printer says finished, until it's answered here or with any
 * status in Project settings: the same condition as the other clients (`ProjectWords`, printed + monitor done).
 */
export function didItFitQuestion(p: Project): string | undefined {
  if (p.state !== "printed" || p.print?.monitor?.endState !== "done") return undefined;
  const status = p.settings?.status ?? p.outcome;
  if (status !== undefined && status !== "printed") return undefined;
  return p.kind === "published" ? "Did it come out right?" : "Did it fit?";
}

/** Sidebar groups describe what the person needs to do, not a second selection state. */
export function projectGroups(projects: Project[]) {
  const groups = ["Now", "Needs you", "Ready", "Printed", "Done", "Drafts"];
  const group = (p: Project) => {
    if (["printing", "touching-up", "sending"].includes(p.state)) return "Now";
    if (["needs-closeup", "failed"].includes(p.state)) return "Needs you";
    if (p.state === "ready") return "Ready";
    if (["printed", "sent"].includes(p.state)) return "Printed";
    if (p.state === "confirmed") return "Done";
    return "Drafts";
  };
  return groups
    .map((title) => ({
      title,
      projects: projects.filter((p) => !p.archived && group(p) === title),
    }))
    .filter((g) => g.projects.length > 0);
}

export function printerSummary(printers: Printer[], projects: Project[]) {
  const problems = printers.filter(
    (p) => p.state === "offline" || p.capabilities?.update != null,
  ).length;
  const printing = printers.filter((printer) =>
    projects.some(
      (p) =>
        p.state === "printing" &&
        p.print?.monitor?.phase !== "ended" &&
        (p.print?.destinationId ?? p.print?.destination?.id) === printer.id,
    ),
  );
  const ready = printers.filter((p) => p.state === "ready").length;
  return {
    problems,
    label: problems
      ? `Printers, ${problems} ${problems === 1 ? "needs" : "need"} attention`
      : "Printers",
    status:
      printing.length === 1
        ? `${printing[0].model ?? printing[0].name} printing`
        : printing.length > 1
          ? `${printing.length} printers printing`
          : `${ready} ${ready === 1 ? "printer" : "printers"} ready`,
  };
}

export function searchProject(p: Project, query: string) {
  return [
    p.title,
    p.instructions,
    p.status?.text,
    p.failure,
    p.current?.summary,
    p.credit?.designer,
    p.credit?.title,
    p.credit?.licence,
    ...(p.messages ?? []).map((x) => x.text),
    ...p.passes.flatMap((x) => [x.note, x.summary]),
    ...(p.current?.changes ?? []).map((x) => x.text),
    ...(p.plates ?? []).map((x) => x.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}
export function parseLayers(text: string, total?: number) {
  if (!text.trim()) return [];
  const parts = text.split(",").map((x) => x.trim());
  if (parts.length > 16 || parts.some((x) => !/^\d+$/.test(x)))
    throw new Error("Enter up to 16 whole layer numbers separated by commas.");
  const layers = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  if (
    layers.some(
      (x) => x < 2 || x > 100000 || (total !== undefined && x > total),
    )
  )
    throw new Error(
      `Pauses must be before layer 2${total ? ` through ${total}` : " or later"}.`,
    );
  return layers;
}
export function normalizeQuestion(raw: RawQuestion): Question {
  if (raw.fields)
    return {
      ...raw,
      fields: raw.fields,
      supported: raw.supported === true && raw.fields.every(supportedField),
    };
  const schema = raw.requestedSchema as
    | {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      }
    | undefined;
  let supported =
    schema?.type === "object" &&
    !!schema.properties &&
    Object.values(schema.properties).every((p) => typeof p.type === "string");
  const fields: Field[] = Object.entries(schema?.properties ?? {}).map(
    ([name, p]) =>
      ({
        ...p,
        name,
        title: typeof p.title === "string" ? p.title : name,
        required: schema?.required?.includes(name) ?? false,
        type: p.type === "boolean" ? undefined : p.type,
      }) as Field,
  );
  supported &&= fields.length <= 64 && fields.every(supportedField);
  return { ...raw, fields, supported: !!supported };
}
function supportedField(f: Field) {
  return (
    (f.type === undefined ||
      ["boolean", "string", "integer", "number"].includes(f.type) ||
      (f.type === "array" && f.items?.type === "string" && !!f.items.enum)) &&
    (!f.enum || f.enum.every((x) => typeof x === "string"))
  );
}
export function validateAnswer(
  q: Question,
  values: Record<string, unknown>,
  now = Date.now(),
): Record<string, string | number | boolean | string[]> {
  if (!q.supported)
    throw new Error("This question uses fields this version cannot answer.");
  if (now >= q.expiresAtMs)
    throw new Error(
      "This question expired. Refresh to read the current question.",
    );
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const f of q.fields) {
    const value = values[f.name];
    if (value === undefined || value === "") {
      if (f.required) throw new Error(`${f.title} is required.`);
      continue;
    }
    if (f.type === "number" || f.type === "integer") {
      const n = typeof value === "number" ? value : Number(value);
      if (
        !Number.isFinite(n) ||
        (f.type === "integer" && !Number.isInteger(n)) ||
        (f.minimum !== undefined && n < f.minimum) ||
        (f.maximum !== undefined && n > f.maximum)
      )
        throw new Error(`${f.title} is outside the allowed range.`);
      out[f.name] = n;
    } else if (!f.type || f.type === "boolean") {
      if (typeof value !== "boolean")
        throw new Error(`${f.title} needs a yes or no answer.`);
      out[f.name] = value;
    } else if (f.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        value.some((v) => typeof v !== "string" || !f.items?.enum?.includes(v))
      )
        throw new Error(`Choose valid values for ${f.title}.`);
      out[f.name] = value;
    } else {
      if (
        typeof value !== "string" ||
        value.length > (f.maxLength ?? 4096) ||
        value.length < (f.minLength ?? 0) ||
        (f.enum && !f.enum.includes(value))
      )
        throw new Error(`Check ${f.title}.`);
      if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        throw new Error("Enter an email address.");
      if (f.format === "uri") {
        try {
          new URL(value);
        } catch {
          throw new Error("Enter a complete URL.");
        }
      }
      out[f.name] = value;
    }
  }
  return out;
}
export const words = (p: Project) =>
  p.status?.text ??
  p.progress ??
  {
    new: "Draft",
    ready: "Ready to print",
    "touching-up": "Working",
    printing: "Printing",
    printed: "Printed",
    confirmed: "Done",
    "needs-closeup": "Needs you",
    failed: "Needs attention",
    sent: "Sent to printer",
  }[p.state] ??
  p.state;
export const activePrint = (p: Project) =>
  p.state === "printing" || !!p.print?.uncertain;
/**
 * Any plate can be chosen except while a step runs. A send Counterpart couldn't confirm stays on its own plate ("unknown")
 * and never locks the others (David, Nov 6: "i can't select which plate to print in the app i can see them but i can't
 * click on them").
 */
export const canSelectPlate = (p: Project) =>
  !!p.plates?.length && p.state !== "printing" && p.state !== "touching-up";
/** Print asks "I checked the printer" first: the last send, or the chosen plate's, may have reached it (the companion's rule). */
export const printNeedsCheck = (p: Project) =>
  !!p.print?.uncertain || p.plates?.find((x) => x.selected)?.uncertain === true;
export const duration = (seconds?: number) =>
  seconds === undefined
    ? "Time unavailable"
    : seconds < 3600
      ? `${Math.ceil(seconds / 60)} min`
      : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
const AXES = ["x", "y", "z"] as const;
export type Axis = (typeof AXES)[number];
const finite3 = (v: Vec3) => v.every(Number.isFinite);
/** Preview coordinates are arbitrary unless scaleMPerUnit proves a metric size. */
export function formatPreviewExtent(review: ReconstructionReview, value: number) {
  if (!Number.isFinite(value)) return "unknown size";
  if (review.scaleKnown && review.scaleMPerUnit && review.scaleMPerUnit > 0)
    return `${(value * review.scaleMPerUnit * 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} mm`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} preview units`;
}
export function formatExtents(
  review: ReconstructionReview,
  extents: ReconstructionReview["extents"],
) {
  return AXES.map((a) => formatPreviewExtent(review, extents[a])).join(" × ");
}
export function componentWords(c: ReconstructionComponent) {
  const share = Math.round(c.share * 100);
  return `Piece ${c.index + 1} — ${share}% of the model · ${c.faces.toLocaleString()} triangles · ${c.vertices.toLocaleString()} points`;
}
/** The component the suggestion describes, matched by its published extents. */
export function suggestedComponent(review: ReconstructionReview) {
  if (review.suggestion?.type !== "component" || !review.components?.length)
    return undefined;
  const wanted = review.suggestion.extents;
  const distance = (c: ReconstructionComponent) =>
    AXES.reduce((sum, a) => {
      const scale = Math.max(Math.abs(wanted[a]), Math.abs(c.extents[a]), 1e-9);
      return sum + Math.abs(wanted[a] - c.extents[a]) / scale;
    }, 0);
  const best = [...review.components].sort((a, b) => distance(a) - distance(b))[0];
  return best && distance(best) < 0.01 ? best : undefined;
}
/** Box to highlight for a selection; undefined when the contract gives no location. */
export function selectionBox(
  review: ReconstructionReview,
  selection: ReconstructionSelection,
): { min: Vec3; max: Vec3 } | undefined {
  if (selection.type === "crop") return { min: selection.min, max: selection.max };
  if (selection.type === "component") {
    const c = review.components?.find((x) => x.index === selection.index);
    return c ? { min: c.boundsMin, max: c.boundsMax } : undefined;
  }
  const c = suggestedComponent(review);
  return c ? { min: c.boundsMin, max: c.boundsMax } : undefined;
}
export function validateCrop(review: ReconstructionReview, min: Vec3, max: Vec3) {
  if (!finite3(min) || !finite3(max) || min.some((v, i) => !(v < max[i]!)))
    throw new Error("Each crop minimum must be below its maximum.");
  if (min.some((v, i) => max[i]! < review.boundsMin[i]! || v > review.boundsMax[i]!))
    throw new Error("That crop does not cover any of the model. Adjust the bounds.");
}
export function buildRegionAnswer(
  review: ReconstructionReview,
  selection: ReconstructionSelection,
): ReconstructionAnswer {
  if (review.kind !== "region" || !review.previewMeshSha256)
    throw new Error("This review changed. Look at the current question and answer again.");
  if (
    selection.type === "component" &&
    review.components &&
    !review.components.some((c) => c.index === selection.index)
  )
    throw new Error("That piece is not in the current preview. Choose again.");
  if (selection.type === "crop") validateCrop(review, selection.min, selection.max);
  if (selection.type === "suggested" && !review.suggestion)
    throw new Error("There is no suggestion in the current preview. Choose a piece or crop.");
  return { type: "region", previewMeshSha256: review.previewMeshSha256, selection };
}
export function parseExtentMm(text: string) {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < 1 || value > 10000)
    throw new Error("Enter a measured size between 1 and 10,000 mm.");
  return value;
}
export function buildScaleAnswer(
  review: ReconstructionReview,
  axis: Axis,
  extentMm: number,
): ReconstructionAnswer {
  if (review.kind !== "scale" || !review.meshSha256)
    throw new Error("This review changed. Look at the current question and answer again.");
  if (!Number.isFinite(extentMm) || extentMm < 1 || extentMm > 10000)
    throw new Error("Enter a measured size between 1 and 10,000 mm.");
  if (!(review.extents[axis] > 0))
    throw new Error("That side has no size in the current model. Choose another side.");
  return { type: "scale", meshSha256: review.meshSha256, axis, extentMm };
}
export function newerProject(existing: Project | undefined, incoming: Project) {
  return existing && existing.updatedAtMs > incoming.updatedAtMs
    ? existing
    : incoming;
}

/** The print sheet's choices: its estimate slices exactly these, and Print sends exactly that slice. */
export interface PrintChoices {
  destinationId: string;
  quality: string;
  strength: string;
  /** Absent when the printer's MCP doesn't offer copies and none were saved: the MCP's own setting. */
  copies?: number;
  filament?: Filament;
  material?: string;
  pauseBeforeLayers: number[];
  /** A multi-colour model: one spool per part, in the model's order, and the model version they were chosen for. */
  spools?: Filament[];
  modelVersion?: string;
}
/**
 * Only what this printer's MCP offers is sent, as the Mac sheet does: a saved "fine" on a printer without the quality
 * choice is refused, and with it the preview Print needs. A sliced plate keeps its own settings (one copy, no pauses).
 */
export function offeredChoices(
  c: PrintChoices,
  printer: {
    capabilities?: Record<string, unknown>;
    sliced: boolean;
    savedCopies: boolean;
  },
): PrintChoices {
  const offers = (choice: string) =>
    !printer.sliced && printer.capabilities?.[choice] === true;
  return {
    ...c,
    quality: offers("quality") ? c.quality : "standard",
    strength: offers("strength") ? c.strength : "standard",
    copies: printer.sliced
      ? 1
      : offers("copies")
        ? c.copies
        : printer.savedCopies
          ? 1
          : undefined,
    pauseBeforeLayers: offers("layerPauses") ? c.pauseBeforeLayers : [],
  };
}
/** `objects.estimate`: every choice Print makes, so the file it slices is the one Print sends. */
export function estimateRequest(id: string, c: PrintChoices) {
  return {
    id,
    destinationId: c.destinationId,
    quality: c.quality,
    strength: c.strength,
    ...(c.copies !== undefined ? { copies: c.copies } : {}),
    ...(c.spools?.length
      ? { filaments: c.spools, filamentsModelVersion: c.modelVersion }
      : c.filament
        ? { filament: c.filament }
        : c.material
          ? { colour: { material: c.material } }
          : {}),
    ...(c.pauseBeforeLayers.length
      ? { pauseBeforeLayers: c.pauseBeforeLayers }
      : {}),
  };
}
/** `objects.print`: the same choices, the plate it was opened on, and the slice whose pictures were shown. */
export function printRequest(
  id: string,
  c: PrintChoices,
  sliceSha256: string,
  expectedPlate?: string,
  checked?: boolean,
) {
  const { destinationId: _destination, ...choices } = estimateRequest(id, c);
  return {
    ...choices,
    ...(expectedPlate ? { expectedPlate } : {}),
    ...(checked ? { checked: true } : {}),
    sliceSha256,
  };
}
/** The slice Print may send: only one whose pictures are of that exact file. */
export function shownSlice(estimate: Estimate | undefined) {
  const sha = estimate?.sliceSha256;
  return sha && estimate.preview?.sha256 === sha && estimate.preview.views.length
    ? sha
    : undefined;
}

/** The effective profile copy, never the package catalog's selected/default version. */
export function mcpUsageWords(
  use: NonNullable<import("./types").McpPackage["uses"]>[number],
): string {
  if (use.words) return use.words;
  const place = use.path ? ` at ${use.path}` : "";
  const source = (use.managed ?? !use.canMove)
    ? "Counterpart’s copy"
    : use.kind === "app" ? `Counterpart’s older copy${place}` : `your copy${place}`;
  return `${use.printer} uses ${source} (${use.version ?? "version unknown"}).`;
}

/** The Moves in the order the uses are listed (never by id), each titled so two Moves for one printer read apart. */
export function mcpMoves(pkg: import("./types").McpPackage): { mcpId: string; title: string }[] {
  if (pkg.moves) return pkg.moves;
  const uses = pkg.uses ?? [];
  return [...new Set(uses.filter((use) => use.canMove).map((use) => use.mcpId))].map((mcpId) => {
    const on = uses.filter((use) => use.mcpId === mcpId), first = on[0]!;
    const from = first.kind === "app"
      ? `Counterpart’s older copy${first.path ? ` at ${first.path}` : ""}`
      : first.path ? `your copy at ${first.path}` : "your copy";
    return { mcpId, title: `Move ${[...new Set(on.map((use) => use.printer))].join(", ")} (${pkg.label}, ${from}) to Counterpart’s updated copy` };
  });
}

/** The installs a package's notices belong to: its printers' and Counterpart's own copy. */
export function mcpPackageIds(pkg: import("./types").McpPackage): string[] {
  return [...new Set([...(pkg.uses ?? []).map((use) => use.mcpId), pkg.appMcpId])];
}

/**
 * What Update's answer says, in words: never the bare state (Nov 6: "waiting" was shown as is). Waiting for a print
 * Counterpart's own work is a sentence, not progress; the mcp.update.* events carry it on from there.
 */
export function mcpUpdateNotice(reply: {update?: {state: string; toVersion?: string; found?: string}; state?: string; toVersion?: string; found?: string}): string {
  const update = reply.update ?? (reply.state ? {state: reply.state, toVersion: reply.toVersion, found: reply.found} : undefined);
  if (!update) return "Update requested.";
  if (update.found) return update.found;
  switch (update.state) {
    case "waiting": return "Updates as soon as Counterpart finishes its work on this printer.";
    case "current": return "Already the newest version.";
    case "started": return update.toVersion ? `Updating to ${update.toVersion}…` : "Updating…";
    default: return "Update requested.";
  }
}

export function mcpMoveNotice(reply: {update: {state: string; found?: string}}): string {
  const update = reply.update;
  if (update.found) return update.found;
  if (update.state === "waiting") return "Moves to Counterpart’s updated copy as soon as Counterpart finishes its work on this printer.";
  if (update.state === "current") return "Already using the current copy.";
  return "Moving to Counterpart’s updated copy…";
}

/**
 * The print sheet's starting choices: the saved defaults, except that a file that prints with its own settings (a
 * designer's 3MF, as its printer's MCP says) starts at Standard quality and strength, which send nothing (Nov 5).
 */
export function startingChoices(project: Pick<Project, "settings" | "preferences" | "current">): PrintOptions {
  const saved = project.settings?.printDefaults ?? project.preferences?.printDefaults ?? {};
  if (!project.current?.ownSettings) return saved;
  const { quality: _quality, strength: _strength, ...rest } = saved;
  return rest;
}

/** What the sheet says under Quality and Strength for a designer's file; nothing for any other. */
export function designerSettingsWords(project: Pick<Project, "current">, quality: string, strength: string): string | undefined {
  if (!project.current?.ownSettings) return undefined;
  return quality === "standard" && strength === "standard"
    ? "Prints with the designer’s settings saved in this file."
    : "Changes the designer’s settings saved in this file.";
}

type Mapping = import("./types").ColourMapping;
/** The printer MCP's proposal per part (part index → spool slot): where the sheet starts. */
export function proposedSlots(mapping: Mapping): Record<number, number> {
  return Object.fromEntries(
    mapping.filaments.flatMap((f) =>
      f.slot === undefined ? [] : [[f.index, f.slot]],
    ),
  );
}
/** The chosen spool for every part, in the model's order; undefined until every part has one. */
export function chosenSpools(
  mapping: Mapping,
  slots: Record<number, number>,
): import("./types").Filament[] | undefined {
  const spools = mapping.filaments.map((f) =>
    mapping.trays.find((t) => t.slot === slots[f.index]),
  );
  return mapping.filaments.length && spools.every((t) => t)
    ? (spools as import("./types").Filament[])
    : undefined;
}
/** The chosen spools come from more than one of the MCP's feeds: one print feeds from one. */
export function mixesFeeds(
  mapping: Mapping,
  slots: Record<number, number>,
): boolean {
  const feeds = new Set(
    Object.values(slots).flatMap((slot) => {
      const feed = mapping.trays.find((t) => t.slot === slot)?.feed;
      return feed ? [feed] : [];
    }),
  );
  return feeds.size > 1;
}
/** What the person should know about a part's spool: the MCP's note while its proposal stands. */
export function partNote(
  mapping: Mapping,
  part: Mapping["filaments"][number],
  slots: Record<number, number>,
): string | undefined {
  if (slots[part.index] === part.slot && part.note) return part.note;
  const tray = mapping.trays.find((t) => t.slot === slots[part.index]);
  if (tray && part.material && tray.material.toUpperCase() !== part.material.toUpperCase())
    return `Prints in ${tray.material}, not ${part.material}.`;
  return undefined;
}
/** A spool as a person reads it: the MCP's label and name ("A2 · Sunflower Yellow PLA Basic"). */
export function spoolTitle(f: import("./types").Filament): string {
  return f.label ? `${f.label} · ${f.name}` : `${f.material} · ${f.name || f.colour}`;
}

/** Keep the latest software result for every MCP operation. */
export function mcpUpdateNotices(previous: Record<string, string>, events: {type: string; title: string; body: string; data?: {mcpId?: string}}[]): Record<string, string> {
  const next = {...previous};
  for (const event of events) {
    if (event.type.startsWith("mcp.update.")) next[event.data?.mcpId ?? event.type] = `${event.title} ${event.body}`;
  }
  return next;
}

/**
 * Add a printer's Slicer section, from the chosen MCP's own `slicer` fields (`counterpart_setup_fields`): its slicer
 * choice, and the paths it reads when it can't find its slicer or Bambu profiles. None for an MCP that declares none.
 */
export function slicerControls(options: SetupOptions | undefined, backend: string) {
  const slicer = options?.slicer?.[backend];
  if (!slicer) return undefined;
  const choice = slicer.fields.find((f) => f.name === "slicer" && f.choices?.length);
  const paths = slicer.fields
    .filter((f) => f.input === "path")
    .map((f) => ({
      field: f,
      key: (f.name === "slicer-path" ? "slicerPath" : "profiles") as "slicerPath" | "profiles",
      placeholder: (f.name === "slicer-path" ? slicer.path : slicer.profilesRoot) ?? "",
    }));
  return {
    choice,
    paths,
    /** The slicer shown as chosen: the person's, else the one the MCP would run. */
    selected: (form: { slicer?: string }) => form.slicer || slicer.type,
    /** What the form keeps for a choice: nothing for the MCP's own, so only a change is sent. */
    choose: (value: string) => (value === slicer.type ? "" : value),
  };
}

/**
 * Add a printer's button that fetches the key or access code for the person, when the chosen MCP declares one for this
 * kind (`obtain` on its secret field, `counterpart_setup_fields`): its words come from the MCP. None otherwise.
 */
export function obtainControl(options: SetupOptions | undefined, form: { printerType?: string; backend?: string }) {
  const obtain = options?.types.find((t) => t.printerType === form.printerType)?.secret?.obtain;
  if (!obtain || !form.backend || !obtain.backends.includes(form.backend)) return undefined;
  return { field: "secret" as const, label: obtain.label, hint: obtain.hint };
}

/**
 * Runs `printers.obtain` for the form until the person answers in the MCP's page, it fails, or `stopped()` (the sheet
 * closed). Each step is shown as it comes; the last is returned, with the value when approved.
 */
export async function obtainValue(
  call: <T>(method: string, params: object) => Promise<T>,
  form: Record<string, string>,
  onStep: (step: import("./types").ObtainStep) => void,
  stopped: () => boolean,
): Promise<import("./types").ObtainStep> {
  const request = {
    backend: form.backend,
    printerType: form.printerType,
    host: form.host?.trim(),
    ...(form.port ? { port: form.port } : {}),
    field: "secret",
  };
  let step = await call<import("./types").ObtainStep>("printers.obtain", request);
  onStep(step);
  while (step.status === "pending" && step.session && !stopped()) {
    step = await call<import("./types").ObtainStep>("printers.obtain", { ...request, session: step.session });
    if (!stopped()) onStep(step);
  }
  return step;
}

/** Add a printer's address field: the MCP's hint, and a placeholder that offers a web address only where the MCP takes one. */
export function addressField(options: SetupOptions | undefined, printerType: string | undefined) {
  const address = options?.types.find((t) => t.printerType === printerType)?.address;
  return {
    hint: address?.hint,
    placeholder: address?.url ? "192.168.1.20, printer.local or https://…" : "192.168.1.20 or printer.local",
  };
}

/** The code design engine's row (PRD §8.9), as the companion's `cad.status` reports the printer MCP's cad_status. */
export interface CodeEngineView {
  state: "checking" | "unavailable" | "not-set-up" | "setting-up" | "ready";
  message: string;
  server?: string;
  seconds?: number;
  /** What it takes on disk, in the companion's words from the MCP's figures: before Set Up, then after. */
  size?: string;
  /** A refusal's sentence and suggestion are the MCP's; its structured result (with its code) is never read here. */
  result?: { ok: boolean; message: string; suggestion?: string };
  canSetUp: boolean;
}
/** What the row shows: the companion's words, Set Up when offered, and whether to keep reading while it works. */
export function codeEngineRow(view: CodeEngineView | undefined): {
  message: string;
  size?: string;
  action?: "Set Up" | "Set Up Again";
  working: boolean;
  result?: { ok: boolean; message: string; suggestion?: string };
} {
  if (!view) return { message: "Checking…", working: true };
  return {
    message: view.message,
    ...(view.size ? { size: view.size } : {}),
    ...(view.canSetUp ? { action: view.state === "ready" ? "Set Up Again" as const : "Set Up" as const } : {}),
    working: view.state === "checking" || view.state === "setting-up",
    ...(view.result ? { result: { ok: view.result.ok, message: view.result.message, ...(view.result.suggestion ? { suggestion: view.result.suggestion } : {}) } } : {}),
  };
}

type Region = { x: number; y: number; width: number; height: number };

/** Inside the picture, or undefined when nothing of it is (CounterpartKit `Region.clamped`). */
export function clampRegion(r: Region | undefined): Region | undefined {
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return undefined;
  const c = (v: number) => Math.min(Math.max(v, 0), 1);
  const left = c(r.x), top = c(r.y), right = c(r.x + r.width), bottom = c(r.y + r.height);
  return right - left > 0.001 && bottom - top > 0.001 ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

/** The words under a question's picture, true for any question (David, Nov 9; CounterpartKit `AskPicture.caption`). */
export function askCaption(ask: { photo?: string; region?: Region } | undefined): string {
  if (!ask?.photo) return "Your project’s picture. No picture came with this question.";
  return clampRegion(ask.region) ? "The outlined part is what this question is about." : "The picture that goes with this question.";
}

/** The scan frames a strip shows: the first, the last and evenly between; 130 give 0, 32, 65, 97, 129 on every client. */
export function scanSample(count: number, shown = 5): number[] {
  if (count <= shown) return Array.from({ length: count }, (_, i) => i);
  if (shown <= 1) return [0];
  return Array.from({ length: shown }, (_, i) => Math.floor((i * (count - 1) + Math.floor((shown - 1) / 2)) / (shown - 1)));
}

export const scanWords = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

/** The line under a project's title in the list grouped by phase (CounterpartKit `ProjectWords.row`). */
export function rowWords(p: Project): string {
  return p.status?.detail?.trim() || words(p);
}
