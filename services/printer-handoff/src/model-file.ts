import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';

export interface ModelPlate {index: number; name: string; objects: string[]; sliced: boolean; thumbnail?: string}
/** One project filament a part of this model prints with (1-based, as `counterpart_make_3mf` numbers them). */
export interface ModelFilament {index: number; name?: string; colour?: string; material?: string}
export interface ModelFileInfo {
  format: 'stl' | '3mf'; sha256: string; byteLength: number;
  title?: string; designer?: string; licence?: string; plates: ModelPlate[];
}
const words = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"}[entity]!))
  .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256);

/** Inspect only bounded package metadata. Never extract paths or execute embedded content. */
export function inspectModelFile(bytes: Buffer, format: 'stl' | '3mf'): ModelFileInfo {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('The model must be at most 64 MiB.');
  const result: ModelFileInfo = {format, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, plates: []};
  if (format === 'stl') {
    const binary = bytes.length >= 84 && 84 + bytes.readUInt32LE(80) * 50 === bytes.length;
    const ascii = /^\s*solid\b/i.test(bytes.subarray(0, 128).toString()) && /\bendsolid\b/i.test(bytes.subarray(-512).toString());
    if (!binary && !ascii) throw new Error('That file is not an STL model.');
    return result;
  }
  const names = new Set<string>();
  let total = 0;
  const files = unzipSync(bytes, {filter: file => {
    if (names.has(file.name)) throw new Error('The model archive has duplicate entries.');
    names.add(file.name);
    const wanted = /^(?:3D\/3dmodel\.model|Metadata\/model_settings\.config|Metadata\/plate_[1-9]\d*\.json)$/.test(file.name);
    if (!wanted) return false;
    total += file.originalSize;
    if (file.originalSize > 8 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('The model metadata is too large.');
    return true;
  }});
  const xml = Buffer.from(files['3D/3dmodel.model'] ?? []).toString('utf8');
  if (!/<(?:\w+:)?model\b/.test(xml) || !names.has('[Content_Types].xml')) throw new Error('That archive is not a 3MF model.');
  const metadata = new Map([...xml.matchAll(/<metadata\s+name="([^"]+)"[^>]*>([^<]*)<\/metadata>/g)].map(match => [match[1]!, words(match[2]!)]));
  if (metadata.get('Title')) result.title = metadata.get('Title');
  if (metadata.get('Designer')) result.designer = metadata.get('Designer');
  if (metadata.get('License')) result.licence = metadata.get('License');
  const settings = Buffer.from(files['Metadata/model_settings.config'] ?? []).toString('utf8');
  const objects = new Map([...settings.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)].map(match => {
    const name = /<metadata\s+key="name"\s+value="([^"]*)"/.exec(match[2]!);
    return [match[1]!, words(name?.[1] ?? '')];
  }));
  const plates = new Map<number, ModelPlate>();
  for (const match of settings.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const id = /<metadata\s+key="plater_id"\s+value="(\d+)"/.exec(match[1]!);
    if (!id) continue;
    const number = Number(id[1]);
    if (number < 1 || number > 1000) throw new Error('The model has an invalid plate number.');
    const name = /<metadata\s+key="plater_name"\s+value="([^"]*)"/.exec(match[1]!);
    plates.set(number, {index: number - 1, name: words(name?.[1] ?? '') || `Plate ${number}`, objects: [...match[1]!.matchAll(/<metadata\s+key="object_id"\s+value="(\d+)"/g)].flatMap(item => objects.get(item[1]!) ? [objects.get(item[1]!)!] : []), sliced: false});
  }
  for (const name of names) {
    const match = /^Metadata\/plate_([1-9]\d*)\.(json|gcode)$/.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    if (number > 1000) throw new Error('The model has an invalid plate number.');
    const plate = plates.get(number) ?? {index: number - 1, name: `Plate ${number}`, objects: [], sliced: false};
    if (match[2] === 'gcode') plate.sliced = true;
    else {
      const value = JSON.parse(Buffer.from(files[name] ?? []).toString('utf8')) as {bbox_objects?: {name?: unknown}[]};
      if (Array.isArray(value.bbox_objects)) plate.objects = value.bbox_objects.flatMap(object => typeof object.name === 'string' && object.name !== 'wipe_tower' ? [words(object.name)] : []).slice(0, 100);
    }
    plates.set(number, plate);
  }
  result.plates = [...plates.values()].sort((a, b) => a.index - b.index);
  // A standard single-build 3MF has no Bambu plate metadata.
  if (!result.plates.length) result.plates.push({index: 0, name: 'Plate 1', objects: [], sliced: false});
  const geometry = /<(?:\w+:)?item\b/.test(xml) && /<(?:\w+:)?(?:mesh|component)\b/.test(xml);
  if (!geometry) {
    result.plates = result.plates.filter(plate => plate.sliced);
    if (!result.plates.length) throw new Error('This 3MF contains previews and settings but no model or printable plate. Download the designer’s model file again.');
  }
  return result;
}

/**
 * How many filament slots this 3MF's project declares, used or not: the longest
 * of the per-filament lists in `project_settings.config` (0 for a designed 3MF
 * with none). Slicing needs one profile per declared slot, so callers size
 * per-filament lists to this, not to the highest used extruder.
 */
export function modelFilamentSlotCount(bytes: Buffer): number {
  const project = projectSettings(bytes);
  if (!project) return 0;
  return Math.min(64, Math.max(0, ...['filament_settings_id', 'filament_type', 'filament_colour', 'filament_diameter']
    .map(key => Array.isArray(project[key]) ? (project[key] as unknown[]).length : 0)));
}

/** Every declared project filament slot with its declared colour and material, used or not. */
export function modelDeclaredFilaments(bytes: Buffer): ModelFilament[] {
  const project = projectSettings(bytes);
  if (!project) return [];
  const list = (key: string): string[] => Array.isArray(project[key]) ? (project[key] as unknown[]).map(String) : [];
  const colours = list('filament_colour'), types = list('filament_type');
  return Array.from({length: modelFilamentSlotCount(bytes)}, (_, i) => {
    const colour = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(colours[i]?.trim() ?? '');
    const material = types[i]?.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64);
    return {index: i + 1, ...(colour ? {colour: `#${colour[1]!.toUpperCase()}`} : {}), ...(material ? {material} : {})};
  });
}

function projectSettings(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined;
    const files = unzipSync(bytes, {filter: file => file.name === 'Metadata/project_settings.config' && file.originalSize <= 8 * 1024 * 1024});
    const file = files['Metadata/project_settings.config'];
    if (!file) return undefined;
    const parsed = JSON.parse(Buffer.from(file).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/**
 * The filaments this 3MF's parts print with: each part's `extruder` from
 * `Metadata/model_settings.config`, with the colour and material the project's
 * `project_settings.config` declares for that filament when the file carries one
 * (published files do; a `counterpart_make_3mf` design does not). When the file
 * is sliced (or Studio-saved) the selected plate's `plate_N.json` `filament_ids`
 * (0-based positions) are the authoritative used set — they cover painted
 * regions no part names. Best effort: an unreadable archive gives none, never
 * a throw — validity is `inspectModelFile`'s job.
 */
export function modelFilaments(bytes: Buffer, plateIndex = 0): ModelFilament[] {
  try {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return [];
    let total = 0;
    const plateName = `Metadata/plate_${plateIndex + 1}.json`;
    const files = unzipSync(bytes, {filter: file => {
      if (!['Metadata/model_settings.config', 'Metadata/project_settings.config', plateName].includes(file.name)) return false;
      total += file.originalSize;
      return file.originalSize <= 8 * 1024 * 1024 && total <= 16 * 1024 * 1024;
    }});
    const settings = Buffer.from(files['Metadata/model_settings.config'] ?? []).toString('utf8');
    const byIndex = new Map<number, ModelFilament>();
    const read = (block: string, part: boolean) => {
      const extruder = /<metadata\s+key="extruder"\s+value="(\d+)"/.exec(block);
      if (!extruder) return;
      const index = Number(extruder[1]);
      if (index < 1 || index > 64) return;
      const name = words(/<metadata\s+key="name"\s+value="([^"]*)"/.exec(block)?.[1] ?? '');
      const existing = byIndex.get(index);
      // A part's own name beats its assembly object's, whichever is read second.
      if (!existing) byIndex.set(index, {index, ...(name ? {name} : {})});
      else if (name && part) existing.name = name;
    };
    // Parts never nest; objects contain parts, so read parts first, then object
    // shells with their part blocks removed (their own name/extruder only).
    for (const block of settings.matchAll(/<part\b[^>]*>([\s\S]*?)<\/part>/g)) read(block[1]!, true);
    const shells = settings.replace(/<part\b[^>]*>[\s\S]*?<\/part>/g, '');
    for (const block of shells.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)) read(block[1]!, false);
    // A sliced plate's own filament list is the used set, replacing part
    // extruders: painted and support filaments appear there and nowhere a part
    // names them, and parts on other plates must not leak into this plate.
    const plateFile = files[plateName];
    if (plateFile) {
      try {
        const plate = JSON.parse(Buffer.from(plateFile).toString('utf8')) as {filament_ids?: unknown};
        const positions = Array.isArray(plate.filament_ids)
          ? [...new Set(plate.filament_ids.filter((value): value is number => Number.isInteger(value)).map(value => value + 1))].filter(index => index >= 1 && index <= 64)
          : [];
        if (positions.length) {
          for (const index of [...byIndex.keys()]) if (!positions.includes(index)) byIndex.delete(index);
          for (const index of positions) if (!byIndex.has(index)) byIndex.set(index, {index});
        }
      } catch { /* the extruder list above still stands */ }
    }
    const projectFile = files['Metadata/project_settings.config'];
    if (projectFile) {
      const project = JSON.parse(Buffer.from(projectFile).toString('utf8')) as Record<string, unknown>;
      const list = (key: string): string[] => Array.isArray(project[key]) ? (project[key] as unknown[]).map(String) : [];
      const colours = list('filament_colour'), types = list('filament_type');
      const count = Math.min(64, Math.max(colours.length, types.length));
      // No per-part assignments to read: every declared filament is in play.
      if (!byIndex.size) for (let index = 1; index <= count; index++) byIndex.set(index, {index});
      for (const filament of byIndex.values()) {
        const colour = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(colours[filament.index - 1]?.trim() ?? '');
        if (colour) filament.colour = `#${colour[1]!.toUpperCase()}`;
        const material = types[filament.index - 1]?.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64);
        if (material) filament.material = material;
      }
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  } catch { return []; }
}

/**
 * Whether the model carries painted regions (per-triangle `paint_color` in the
 * model XML, the Bambu/Prusa painting record). Painting is the evidence that a
 * declared filament no part names may still print; without it such a slot is
 * just an unused project preset.
 */
export function modelHasPainting(bytes: Buffer): boolean {
  try {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    // Studio keeps the mesh — and its painting — in component files under
    // 3D/Objects/, referenced from the root model; scan those too, bounded.
    let total = 0, count = 0;
    const files = unzipSync(bytes, {filter: file => {
      if (file.name !== '3D/3dmodel.model' && !/^3D\/Objects\/[^/]+\.model$/.test(file.name)) return false;
      total += file.originalSize;
      return file.originalSize <= 32 * 1024 * 1024 && total <= 48 * 1024 * 1024 && ++count <= 64;
    }});
    return Object.values(files).some(model => Buffer.from(model).includes('paint_color="'));
  } catch { return false; }
}

/**
 * The filament indices (1-based) the selected plate's `plate_N.json` says it
 * uses, or undefined when the file carries no usable plate list. When this is
 * defined it is authoritative: a declared slot outside it does not print on
 * this plate at all.
 */
export function modelPlateFilaments(bytes: Buffer, plateIndex = 0): number[] | undefined {
  try {
    if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined;
    const plateName = `Metadata/plate_${plateIndex + 1}.json`;
    const files = unzipSync(bytes, {filter: file => file.name === plateName && file.originalSize <= 8 * 1024 * 1024});
    const plateFile = files[plateName];
    if (!plateFile) return undefined;
    const plate = JSON.parse(Buffer.from(plateFile).toString('utf8')) as {filament_ids?: unknown};
    const positions = Array.isArray(plate.filament_ids)
      ? [...new Set(plate.filament_ids.filter((value): value is number => Number.isInteger(value)).map(value => value + 1))].filter(index => index >= 1 && index <= 64)
      : [];
    return positions.length ? positions : undefined;
  } catch { return undefined; }
}

/** A designer-supplied plate image, copied as a preview; never a substitute for model geometry. */
export function modelPlatePreview(bytes: Buffer, index: number): Buffer | undefined {
  const name = `Metadata/plate_${index + 1}.png`;
  const files = unzipSync(bytes, {filter: file => file.name === name && file.originalSize <= 8 * 1024 * 1024});
  const image = files[name];
  if (!image || image.length < 24) return undefined;
  const png = Buffer.from(image);
  if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return undefined;
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 ? png : undefined;
}

/** Snapshot a regular model file without following a symlink or reading past its admitted size. */
export async function readModelFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 64 * 1024 * 1024) throw new Error('Choose a model file at most 64 MiB.');
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    if (offset !== info.size) throw new Error('The model file changed while it was read. Try again.');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
