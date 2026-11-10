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
  if (plates.length > 1)
    return plates.flatMap((plate, index) =>
      plate.thumbnail
        ? [{ id: `plate-${plate.id}`, label: plate.name || `Plate ${index + 1}`, drawing: { picture: plate.thumbnail }, colour: "own", plate: true }]
        : [],
    );
  const current = p.current;
  if (!current) return [];
  const label = p.kind === "copy" ? "Your copy" : p.kind === "published" ? "Model" : "Your part";
  if (current.model.toLowerCase().endsWith(".3mf")) {
    const render = current.renders[0] ? renderPath(current.renders[0]) : plates[0]?.thumbnail;
    return render ? [{ id: "result", label, drawing: { picture: render }, colour: "own", sizeMm: current.sizeMm }] : [];
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
  if (parts.length === 1 && "model" in parts[0]!.drawing && seats.length && scans.length)
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

/** The computer's picture of one entry, for the still view. */
export function pictureFor(p: Project, entry: GalleryEntry): string | undefined {
  if ("picture" in entry.drawing) return entry.drawing.picture;
  if (entry.kind === "part") return p.pictures?.part ?? (p.current?.renders[0] ? renderPath(p.current.renders[0]) : undefined);
  if (entry.kind === "together") return p.pictures?.together;
  return p.pictures?.scan ?? p.pictures?.photo;
}

/** A companion path as a file in the project's folder: renders by name, the model at its own path. */
export function filePath(p: Project, path: string): string {
  if (path === "model.stl") return p.current?.model.toLowerCase().endsWith(".stl") ? p.current.model : "current/model.stl";
  if (path.startsWith("renders/")) return p.current?.renders.find((render) => render.split("/").pop() === path.slice(8)) ?? path;
  return path;
}

/** A fit part made before passes said where the scanned object sits: the computer can find it. */
export function canLocate(p: Project): boolean {
  return p.kind === "fit" && !!p.scan && !!p.current && p.current.model.toLowerCase().endsWith(".stl") && !p.current.seats?.length
    && p.state !== "printing" && p.state !== "touching-up";
}
