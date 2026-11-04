/**
 * Which loaded spool prints each of a model's colours: the nearest colour in OKLab
 * (perceptual) space, with the asked-for material preferred. Pure: the service
 * supplies the model's colours and the printer's live trays.
 */

/** One of the model's filaments, in project-filament order. Colour is `#RRGGBB` when known. */
export interface ModelColour {colour?: string; material?: string}
/** One loaded tray: absolute AMS slot (254/255 are the external spools), its colour and material. */
export interface TrayColour {slot: number; colour: string; material: string}
export interface ColourMatch {
  slot: number;
  /** OKLab distance to the asked-for colour; absent when the colour was unknown. */
  distance?: number;
  /** The chosen spool is a different material than the model asked for. */
  materialMismatch?: boolean;
  /** No colour was known: this spool is a placeholder for the person to confirm. */
  guessed?: boolean;
}

/** sRGB `#RRGGBB(AA)` to OKLab; undefined when the text is not a hex colour. Alpha is ignored. */
function oklab(hex: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(value >> 16 & 255), g = linear(value >> 8 & 255), b = linear(value & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Perceptual distance between two `#RRGGBB` colours (0 identical, about 1 black to white). */
export function colourDistance(a: string, b: string): number {
  const left = oklab(a), right = oklab(b);
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

const materialOf = (value: string | undefined) => value?.trim().toUpperCase() || undefined;
/** A wrong-material spool must beat the right material by this much colour distance to win. */
const MATERIAL_PENALTY = 0.15;

/**
 * One match per model filament, in order; `undefined` where no tray is loaded.
 * The same spool may serve several filaments of the same colour. A filament with
 * no known colour takes the first still-unassigned spool of its material (else
 * any unassigned spool, else the first) and is marked `guessed`.
 */
export function matchColours(model: ModelColour[], trays: TrayColour[]): (ColourMatch | undefined)[] {
  const loaded = trays.filter(tray => oklab(tray.colour));
  const assigned = new Set<number>();
  return model.map(filament => {
    if (!loaded.length) return undefined;
    const wanted = materialOf(filament.material);
    const mismatch = (tray: TrayColour) => wanted !== undefined && materialOf(tray.material) !== wanted;
    const target = filament.colour ? oklab(filament.colour) : undefined;
    if (!target) {
      const free = loaded.filter(tray => !assigned.has(tray.slot));
      const pool = free.length ? free : loaded;
      const chosen = pool.find(tray => !mismatch(tray)) ?? pool[0]!;
      assigned.add(chosen.slot);
      return {slot: chosen.slot, guessed: true, ...(mismatch(chosen) ? {materialMismatch: true} : {})};
    }
    let best: {tray: TrayColour; distance: number; score: number} | undefined;
    for (const tray of loaded) {
      const distance = colourDistance(filament.colour!, tray.colour);
      const score = distance + (mismatch(tray) ? MATERIAL_PENALTY : 0);
      if (!best || score < best.score || (score === best.score && tray.slot < best.tray.slot)) best = {tray, distance, score};
    }
    assigned.add(best!.tray.slot);
    return {slot: best!.tray.slot, distance: best!.distance, ...(mismatch(best!.tray) ? {materialMismatch: true} : {})};
  });
}
