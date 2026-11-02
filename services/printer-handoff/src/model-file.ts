import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';

export interface ModelPlate {index: number; name: string; objects: string[]; sliced: boolean; thumbnail?: string}
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
