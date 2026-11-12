import type { Project } from "./types";

/**
 * The pictures at the top of a project's page (PRD §5.4 Pictures), derived from its data, in order. Port of
 * CounterpartKit `ProjectGallery`; Swift, Android and this read `packages/contracts/fixtures/project-gallery.json`.
 * Paths are the companion's (`model.stl`, `renders/…`, `scan/…`, `pictures/…`); `filePath` maps them to the
 * project folder this app reads.
 */
export type GalleryKind = "part" | "plate" | "together" | "scan";
export type Seat = { name?: string; translationMm: number[]; rotationDeg: number[] };
export type Drawing =
  | { model: string }
  | { picture: string }
  | { assembly: { part: string; object: string; seats: Seat[] } };
/** "neutral", "own", or the spool's `#RRGGBB`. */
export type Colour = string;
export interface GalleryEntry {
  id: string;
  kind: GalleryKind;
  label: string;
  drawing: Drawing;
  colour: Colour;
  measures: string;
  sizeMm?: number[];
  photos?: string[];
}
/** One thing that will print: the result or a designer's plate today; the seam a project's part list will feed. */
export interface PrintablePart {
  id: string;
  label: string;
  drawing: Drawing;
  colour: Colour;
  sizeMm?: number[];
  plate?: boolean;
}

const hex = (text?: string) => {
  const match = text ? /^#?([0-9A-Fa-f]{6})/.exec(text.trim()) : null;
  return match ? `#${match[1]!.toUpperCase()}` : undefined;
};
const renderPath = (render: string) => `renders/${render.split("/").pop()}`;

/** The one spool the result prints in: its last print's spools, else the colour the printer reported printing it. */
export function spoolColour(p: Project): string | undefined {
  const spools = p.print?.spools;
  if (spools?.length)
    return new Set(spools.map((s) => hex(s.colour))).size === 1 ? hex(spools[0]!.colour) : undefined;
  return hex(p.print?.live?.activeFilament?.color);
}

export function printableParts(p: Project): PrintablePart[] {
  const plates = p.plates ?? [];
  // Every plate the file has is an entry; one whose picture the MCP didn't send shows the placeholder ("").
  if (plates.length > 1)
    return plates.map((plate, index) => ({
      id: `plate-${plate.id}`, label: plate.name || `Plate ${index + 1}`, drawing: { picture: plate.thumbnail ?? "" }, colour: "own", plate: true,
    }));
  const current = p.current;
  if (!current) return [];
  const label = p.kind === "copy" ? "Your copy" : p.kind === "published" ? "Model" : "Your part";
  if (current.model.toLowerCase().endsWith(".3mf")) {
    // The computer's drawing of all the file's objects first, as on the other clients (Nov 10).
    // Always an entry (review B2 on #539): with no picture yet ("") the stage says it is coming or that it can't be had.
    const render = p.pictures?.part ?? (current.renders[0] ? renderPath(current.renders[0]) : plates[0]?.thumbnail) ?? "";
    return [{ id: "result", label, drawing: { picture: render }, colour: "own", sizeMm: current.sizeMm }];
  }
  return [{ id: "result", label, drawing: { model: "model.stl" }, colour: spoolColour(p) ?? "neutral", sizeMm: current.sizeMm }];
}

export function scanModels(p: Project): string[] {
  return p.scan && /\.(usdz|usdc|usda|stl)$/i.test(p.scan) ? [`scan/${p.scan}`] : [];
}

export function gallery(p: Project, parts: PrintablePart[] = printableParts(p)): GalleryEntry[] {
  const entries: GalleryEntry[] = parts.map((part) => ({
    id: part.id, kind: part.plate ? "plate" : "part", label: part.label, drawing: part.drawing, colour: part.colour,
    measures: part.plate ? "Plate" : "Part", ...(part.sizeMm ? { sizeMm: part.sizeMm } : {}),
  }));
  const scans = scanModels(p);
  const seats = p.current?.seats ?? [];
  // Only where it is drawn right today: a USDZ scan. A handheld STL scan gets no Together until the project carries its frame.
  if (parts.length === 1 && "model" in parts[0]!.drawing && seats.length && scans.length && scans[0]!.toLowerCase().endsWith(".usdz"))
    entries.push({ id: "together", kind: "together", label: "Together", drawing: { assembly: { part: parts[0]!.drawing.model, object: scans[0]!, seats } },
      colour: parts[0]!.colour, measures: "Together" });
  const photos = p.photos.length ? p.photos.map((name) => `photos/${name}`) : (p.capture ?? []).map((name) => `capture/${name}`);
  scans.forEach((scan, index) =>
    entries.push({ id: `scan-${index}`, kind: "scan", label: scans.length > 1 ? `Scan ${index + 1}` : "What you scanned", drawing: { model: scan },
      colour: "own", measures: "Scan", photos }),
  );
  // A copy before a spool is chosen leads with the scanned object in its own colours (the mockup's potato).
  const scanAt = entries.findIndex((e) => e.kind === "scan");
  if (p.kind === "copy" && !spoolColour(p) && scanAt > 0) entries.unshift(...entries.splice(scanAt, 1));
  return entries;
}

/** The size chip: what it measures and its size ("Part · 213 × 43 × 82 mm"). */
export function sizeText(entry: GalleryEntry): string | undefined {
  const mm = entry.sizeMm;
  if (!mm || mm.length !== 3) return undefined;
  return `${entry.measures} · ${mm.map((v) => (v > 0 && v < 0.05 ? "<0.1" : v.toFixed(1).replace(/\.0$/, ""))).join(" × ")} mm`;
}

/**
 * The project's picture everywhere (cards, the sidebar, search): the gallery's first entry drawn by the computer as
 * the object alone on the stage (`picture`); until then a designer's plate or a design's render; never a photo of the
 * room (David, Nov 10). Undefined shows the placeholder.
 */
export function picturePath(p: Project): string | undefined {
  const plate = p.plates?.find((item) => item.selected)?.thumbnail ?? p.plates?.[0]?.thumbnail;
  return p.picture ?? plate ?? (p.current?.renders[0] ? renderPath(p.current.renders[0]) : undefined) ?? p.credit?.thumbnail;
}

/** The page's picture while the gallery is empty (photos sent, no model yet): the subject the computer cut out of the photo. */
export function photoPicture(p: Project): string | undefined {
  return p.pictures?.photo;
}

/** The computer's picture of one entry, for the still view. Undefined when there is none yet (`still` says whether one is coming). */
export function pictureFor(p: Project, entry: GalleryEntry): string | undefined {
  if ("picture" in entry.drawing) return entry.drawing.picture || undefined;
  if (entry.kind === "part") return p.pictures?.part ?? (p.current?.renders[0] ? renderPath(p.current.renders[0]) : undefined);
  if (entry.kind === "together") return p.pictures?.together;
  return p.pictures?.scan ?? p.pictures?.photo;
}

/**
 * What the stage shows for an entry while no model is drawn (CounterpartKit `Project.still(for:)`): its own picture, or
 * "waiting" (one is coming), or "not available" (the computer's drawing failed, or a plate came without its picture). A
 * picture of something else never stands in for it.
 */
export type Still = { picture: string } | "waiting" | "not available";
export function still(p: Project, entry: GalleryEntry): Still {
  const picture = pictureFor(p, entry);
  if (picture) return { picture };
  if (entry.kind === "plate") return "not available";
  return p.pictureStates?.[entry.kind === "together" ? "together" : entry.kind === "scan" ? "scan" : "part"] === "failed" ? "not available" : "waiting";
}

/** A companion path as a file in the project's folder: renders by name, the model at its own path. */
export function filePath(p: Project, path: string): string {
  // A 3MF's merged mesh sits beside it: `current/model.stl`, or a sealed design's `versions/<id>/model.stl` (#616).
  if (path === "model.stl") {
    const model = p.current?.model;
    if (model?.toLowerCase().endsWith(".stl")) return model;
    return model?.includes("/") ? `${model.slice(0, model.lastIndexOf("/"))}/model.stl` : "current/model.stl";
  }
  if (path.startsWith("renders/")) return p.current?.renders.find((render) => render.split("/").pop() === path.slice(8)) ?? path;
  return path;
}

/** A fit part made before passes said where the scanned object sits: the computer can find it. */
export function canLocate(p: Project): boolean {
  // Only for a USDZ scan, the one frame Together is drawn in today (PRD §6.1).
  return p.kind === "fit" && !!p.scan?.toLowerCase().endsWith(".usdz") && !!p.current && p.current.model.toLowerCase().endsWith(".stl") && !p.current.seats?.length
    && p.state !== "printing" && p.state !== "touching-up";
}

/**
 * The colour the stage's material draws a spool in (CounterpartKit `StageMaterial`): the stage stays dark
 * (#22242B) for every part, and a dark filament is lifted to a minimum brightness of 0.20 — the Mac's still
 * pictures' floor — so black is charcoal, never a silhouette. "neutral"/"own" pass through; a spool's real
 * colour still shows in swatches and names.
 */
export function drawnColour(colour: Colour): Colour {
  if (!/^#[0-9A-Fa-f]{6}$/.test(colour)) return colour;
  const value = parseInt(colour.slice(1, 7), 16);
  const rgb = [16, 8, 0].map((shift) => ((value >> shift) & 255) / 255);
  const floor = 0.20;
  const brightness = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  if (brightness < floor) {
    const lift = (floor - brightness) / floor;
    [1.0, 1.01, 1.04].forEach((m, i) => { rgb[i] = rgb[i]! + lift * floor * m; });
  }
  return "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0").toUpperCase()).join("");
}

/**
 * How long the stage says a picture is coming while nothing is running before it settles (#626). The computer draws a
 * picture in seconds after a pass; a companion that can't draw one (Linux) never says so, so "coming" must end.
 */
export const PICTURE_PATIENCE_MS = 20_000;
export const NOT_DRAWN_LINE = "Your computer hasn't drawn a picture of this.";
/**
 * The stage's one still, settled (#626; CounterpartKit `StagePicture`): the picture; "waiting" with one line while
 * something is running or the computer says it is drawing it, or for a short while after; then a plain reason with
 * Try Again, never an endless "coming from your computer". `waitedMs` is how long this page has waited for it.
 */
export type StageStillState =
  | { state: "picture"; picture: string }
  | { state: "waiting"; line: string }
  | { state: "not available"; line: string; retry: boolean };
export function stageStill(p: Project, shown: Still, label: string, unavailableLine: string, waitedMs: number, role?: GalleryKind): StageStillState {
  if (typeof shown === "object") return { state: "picture", picture: shown.picture };
  if (shown === "not available") return { state: "not available", line: unavailableLine, retry: false };
  const key = role === "together" ? "together" : role === "scan" ? "scan" : role === "part" ? "part" : undefined;
  const busy = p.state === "touching-up" || (key !== undefined && p.pictureStates?.[key] === "drawing");
  if (busy || waitedMs < PICTURE_PATIENCE_MS) return { state: "waiting", line: `${label}: coming from your computer` };
  // Nothing is running and no picture came: say so, and Try Again waits once more (a picture that arrives shows at once).
  return { state: "not available", line: role ? NOT_DRAWN_LINE : unavailableLine, retry: !!role };
}
/**
 * The stage's clock for one thing it waits for (#626), as `StagePicture` runs it: `watch` starts a new clock whenever
 * what is awaited changes (another picture, another entry, Try again) and, while it waits, wakes `settle` once the
 * patience is up; `waited` is how long that same thing has been awaited (0 for anything else).
 */
export function pictureClock(settle: () => void, patience = PICTURE_PATIENCE_MS) {
  let key: string | undefined, since = 0, timer: ReturnType<typeof setTimeout> | undefined;
  return {
    watch(next: string, waiting: boolean) {
      if (next === key) return;
      clearTimeout(timer);
      timer = undefined;
      key = next;
      since = Date.now();
      if (waiting) timer = setTimeout(() => { timer = undefined; settle(); }, patience + 50);
    },
    waited(of: string) { return of === key ? Date.now() - since : 0; },
    /** Unmounting forgets what it watched, so a remount (React StrictMode's included) starts the clock again. */
    stop() { clearTimeout(timer); timer = undefined; key = undefined; },
  };
}
