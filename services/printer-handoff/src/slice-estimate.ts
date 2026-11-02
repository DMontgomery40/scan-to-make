import {unzipSync, strFromU8} from 'fflate';

export interface SliceEstimate { seconds?: number; grams?: number }
export interface SliceSettings { layerHeightMm?: number; infillPercent?: number; wallLoops?: number; layers?: number }

const positive = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;

/**
 * What a sliced file was sliced with: Bambu/Orca 3MF (`Metadata/project_settings.config`,
 * and the plate G-code's header for the layer count) or a G-code file's own header comments.
 */
export async function sliceSettings(bytes: Buffer, plateIndex = 0): Promise<SliceSettings> {
  try {
    if (bytes.length > 256 * 1024 * 1024) return {};
    const fromHeader = (text: string): SliceSettings => {
      const read = (pattern: RegExp) => positive(text.match(pattern)?.[1]);
      const layers = read(/^;\s*(?:total layer number|total layers count|LAYER_COUNT)\s*[:=]\s*(\d+)/im);
      const layerHeightMm = read(/^;\s*layer_height\s*=\s*([\d.]+)/im);
      const infillPercent = read(/^;\s*(?:sparse_infill_density|fill_density)\s*=\s*([\d.]+)%/im);
      const wallLoops = read(/^;\s*(?:wall_loops|perimeters)\s*=\s*(\d+)/im);
      return {...(layerHeightMm !== undefined ? {layerHeightMm} : {}), ...(infillPercent !== undefined ? {infillPercent} : {}),
        ...(wallLoops !== undefined ? {wallLoops: Math.trunc(wallLoops)} : {}), ...(layers ? {layers: Math.trunc(layers)} : {})};
    };
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      // G-code: settings are in a footer (PrusaSlicer, Orca) or a header; read both ends.
      return fromHeader(bytes.subarray(0, 256 * 1024).toString('latin1') + '\n' + bytes.subarray(Math.max(0, bytes.length - 256 * 1024)).toString('latin1'));
    }
    const plate = `Metadata/plate_${plateIndex + 1}.gcode`;
    const files = unzipSync(bytes, {filter: file => (file.name === 'Metadata/project_settings.config' && file.originalSize <= 8 * 1024 * 1024) || (file.name === plate && file.originalSize <= 512 * 1024 * 1024)});
    const settingsFile = files['Metadata/project_settings.config'];
    let result: SliceSettings = {};
    if (settingsFile) {
      try {
        const settings = JSON.parse(strFromU8(settingsFile)) as Record<string, unknown>;
        const layerHeightMm = positive(first(settings.layer_height)), infill = positive(String(first(settings.sparse_infill_density) ?? '').replace('%', ''));
        const wallLoops = positive(first(settings.wall_loops));
        result = {...(layerHeightMm !== undefined ? {layerHeightMm} : {}), ...(infill !== undefined && String(first(settings.sparse_infill_density) ?? '') !== '' ? {infillPercent: infill} : {}),
          ...(wallLoops !== undefined ? {wallLoops: Math.trunc(wallLoops)} : {})};
      } catch { /* settings stay unknown */ }
    }
    const gcode = files[plate];
    // The project settings are authoritative; the plate G-code's header adds the layer count.
    if (gcode) result = {...fromHeader(strFromU8(gcode.subarray(0, 64 * 1024))), ...result};
    return result;
  } catch { return {}; }
}

/** Bambu/Orca store per-plate estimates in the sliced 3MF, not in the model. */
export async function sliceEstimate(bytes: Buffer, plateIndex = 0): Promise<SliceEstimate | undefined> {
  try {
    if (bytes.length > 128 * 1024 * 1024 || plateIndex < 0 || !Number.isInteger(plateIndex)) return undefined;
    const files = unzipSync(bytes, {filter:file => file.name === 'Metadata/slice_info.config' && file.originalSize <= 1024 * 1024});
    const metadata = files['Metadata/slice_info.config'];
    if (!metadata) return undefined;
    const xml = strFromU8(metadata);
    const plates = xml.match(/<plate(?:\s[^>]*)?>[\s\S]*?<\/plate>/g) ?? [];
    const plate = plates.find(p => new RegExp(`<metadata\\s+key=["']index["']\\s+value=["']${plateIndex + 1}["']`).test(p));
    if (!plate) return undefined;
    const value = (key: string) => {
      const text = plate.match(new RegExp(`<metadata\\s+key=["']${key}["']\\s+value=["']([^"']+)["']`))?.[1];
      if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return undefined;
      const number = Number(text);
      return Number.isFinite(number) && number > 0 ? number : undefined;
    };
    const seconds = value('prediction'), grams = value('weight');
    return seconds === undefined && grams === undefined ? undefined : {...(seconds === undefined ? {} : {seconds}), ...(grams === undefined ? {} : {grams})};
  } catch { return undefined; }
}
