import {readFile} from 'node:fs/promises';

/**
 * Where the scanned object sits in a fit part (docs/protocols/seats.md): one rigid placement of the scan in the part's
 * frame per place the object goes. The worker that designed the part reports them; the companion keeps them with the
 * project's current model and checks them only for nonsense (never a fit judgement, never printer or engine geometry).
 *
 * Frames, both millimetres and Z up:
 * - the part: the model as the pass exported it (`current/model.stl`), in the orientation it is used in;
 * - the scan: the project's scan model (`scan/scan.usdz`) in its own world coordinates, scaled to millimetres and turned
 *   so its up axis is +Z by the smallest rotation (a +Y-up capture: (x, y, z) becomes (x, −z, y)); not moved, centred
 *   or dropped to the floor. That is the printer MCP's `load_scan(…, ground=False)`.
 * A seat turns the scan about the fixed X, then Y, then Z axes through the origin (`rotationDeg`), then moves it
 * (`translationMm`): exactly the transform `cad_check_fit` takes, so one number set serves both.
 */
export interface Seat {
  /** "left", "middle", "right": only when there is more than one. */
  name?: string;
  translationMm: [number, number, number];
  rotationDeg: [number, number, number];
  /** What the printer MCP's `cad_check_fit` said for this seat, when the worker ran it. Information, never a verdict here. */
  check?: {minimumGapMm?: number; interferenceMm3?: number; clear?: boolean};
}

export interface Bounds {min: [number, number, number]; max: [number, number, number]}

const MAX_SEATS = 32;
const LIMIT_MM = 10_000;

const finite = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const triple = (value: unknown, limit: number): [number, number, number] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every(item => finite(item, limit)) ? [value[0], value[1], value[2]] as [number, number, number] : undefined;

/** The worker's `seats`, kept only when every entry is a well-formed placement. Undefined for none or any malformed one. */
export function parseSeats(raw: unknown, publicText: (text: string) => string = text => text): Seat[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEATS) return undefined;
  const seats: Seat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const entry = item as Record<string, unknown>;
    const translationMm = triple(entry.translationMm, LIMIT_MM), rotationDeg = triple(entry.rotationDeg, 3600);
    if (!translationMm || !rotationDeg) return undefined;
    const name = typeof entry.name === 'string' && entry.name.trim() ? publicText(entry.name.trim()).slice(0, 40) : undefined;
    const check = entry.check && typeof entry.check === 'object' ? entry.check as Record<string, unknown> : undefined;
    const kept = check ? {
      ...(finite(check.minimumGapMm, LIMIT_MM) && check.minimumGapMm >= 0 ? {minimumGapMm: check.minimumGapMm} : {}),
      ...(finite(check.interferenceMm3, 1e12) && check.interferenceMm3 >= 0 ? {interferenceMm3: check.interferenceMm3} : {}),
      ...(typeof check.clear === 'boolean' ? {clear: check.clear} : {}),
    } : undefined;
    seats.push({...(name ? {name} : {}), translationMm, rotationDeg, ...(kept && Object.keys(kept).length ? {check: kept} : {})});
  }
  return seats;
}

/** The seat as a 4×4 row-major matrix: Rz·Ry·Rx, then the translation (trimesh `euler_matrix(…, 'sxyz')`). */
export function seatMatrix(seat: Pick<Seat, 'translationMm' | 'rotationDeg'>): number[] {
  const [ax, ay, az] = seat.rotationDeg.map(degrees => degrees * Math.PI / 180) as [number, number, number];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const [tx, ty, tz] = seat.translationMm;
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, tx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, ty,
    -sy, cy * sx, cy * cx, tz,
    0, 0, 0, 1,
  ].map(value => value + 0);
}

export function transformPoint(matrix: number[], [x, y, z]: [number, number, number]): [number, number, number] {
  return [matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
    matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
    matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!];
}

/** The box around a box after a rigid transform: its eight corners, transformed. */
export function transformBounds(matrix: number[], bounds: Bounds): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = transformPoint(matrix, [corner & 1 ? bounds.max[0] : bounds.min[0], corner & 2 ? bounds.max[1] : bounds.min[1], corner & 4 ? bounds.max[2] : bounds.min[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, point[k]!); max[k] = Math.max(max[k]!, point[k]!); }
  }
  return {min, max};
}

/** An STL's bounds in its own units (binary or ASCII); undefined when it holds no finite triangle. */
export function stlBounds(bytes: Buffer): Bounds | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
  };
  const count = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  if (count > 0 && bytes.length === 84 + 50 * count) {
    for (let t = 0; t < count; t++) for (let v = 0; v < 3; v++) {
      const base = 84 + 50 * t + 12 + 12 * v;
      add(bytes.readFloatLE(base), bytes.readFloatLE(base + 4), bytes.readFloatLE(base + 8));
    }
  } else {
    for (const match of bytes.toString('latin1').matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) add(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return min[0] === Infinity ? undefined : {min, max};
}

/** An OBJ's vertex bounds (`v x y z` lines), in the file's own units. */
export function objBounds(text: string): Bounds | undefined {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const match of text.matchAll(/^v\s+(\S+)\s+(\S+)\s+(\S+)/gm)) {
    const point = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!point.every(Number.isFinite)) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, point[k]!); max[k] = Math.max(max[k]!, point[k]!); }
  }
  return min[0] === Infinity ? undefined : {min, max};
}

/**
 * The scan's frame from its own (native units, its up axis): millimetres, +Z up, by the smallest rotation about X or
 * Y (a +Y-up capture: (x, y, z) → (x, −z, y)), never moved. The printer MCP's `load_scan` with `ground=False`.
 */
export function scanFrameMatrix(unitMetres: number, upAxis: string): number[] | undefined {
  const s = unitMetres * 1000;
  if (!(s > 0) || !Number.isFinite(s)) return undefined;
  const turns: Record<string, number[]> = {
    z: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    '-z': [1, 0, 0, 0, -1, 0, 0, 0, -1],
    y: [1, 0, 0, 0, 0, -1, 0, 1, 0],
    '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
    x: [0, 0, -1, 0, 1, 0, 1, 0, 0],
    '-x': [0, 0, 1, 0, 1, 0, -1, 0, 0],
  };
  const r = turns[upAxis.toLowerCase()];
  if (!r) return undefined;
  return [r[0]! * s, r[1]! * s, r[2]! * s, 0, r[3]! * s, r[4]! * s, r[5]! * s, 0, r[6]! * s, r[7]! * s, r[8]! * s, 0, 0, 0, 0, 1];
}

const overlaps = (a: Bounds, b: Bounds) => [0, 1, 2].every(k => a.min[k]! < b.max[k]! && b.min[k]! < a.max[k]!);

/**
 * Nonsense the companion refuses from what it already has: a seat whose scan box doesn't reach the part's box at
 * all, or two seats at the same place. `scan` is the scan's box in the scan frame; without it only sameness is checked.
 * Undefined when the seats pass; otherwise the reason, in words for the pass's activity.
 */
export function seatsProblem(seats: Seat[], part: Bounds | undefined, scan: Bounds | undefined): string | undefined {
  for (let i = 0; i < seats.length; i++) for (let j = i + 1; j < seats.length; j++) {
    const a = seats[i]!, b = seats[j]!;
    const apart = Math.hypot(...a.translationMm.map((value, k) => value - b.translationMm[k]!));
    const turned = Math.max(...a.rotationDeg.map((value, k) => Math.abs(value - b.rotationDeg[k]!)));
    if (apart < 0.5 && turned < 0.5) return `Two places for the object are the same (${a.name ?? `place ${i + 1}`} and ${b.name ?? `place ${j + 1}`}).`;
  }
  if (part && scan) for (const [index, seat] of seats.entries()) {
    if (!overlaps(transformBounds(seatMatrix(seat), scan), part)) return `The object placed at ${seat.name ?? `place ${index + 1}`} doesn't touch the part at all.`;
  }
  return undefined;
}

/** The scan's box in the scan frame, from the capture converter's OBJ and its report (unit, up axis). */
export function scanBoundsFromObj(objText: string, unitMetres: number, upAxis: string): Bounds | undefined {
  const native = objBounds(objText), frame = scanFrameMatrix(unitMetres, upAxis);
  return native && frame ? transformBounds(frame, native) : undefined;
}

export async function stlFileBounds(path: string): Promise<Bounds | undefined> {
  return stlBounds(await readFile(path).catch(() => Buffer.alloc(0)));
}

/** Seats are stated, never inherited by a model that changed: a pass that changed the geometry and gave none has none. */
export function carriedSeats(previous: Seat[] | undefined, given: Seat[] | undefined, modelUnchanged: boolean): Seat[] | undefined {
  if (given?.length) return given;
  return modelUnchanged ? previous : undefined;
}
