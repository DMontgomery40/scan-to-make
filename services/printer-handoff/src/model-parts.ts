import {resolve, sep} from 'node:path';

/**
 * #691: a 3MF's parts as the printer MCP meshes them (counterpart/1 `counterpart_part_meshes`, bambu-printer-mcp
 * 1.1.97 and mcp-3d-printer-server 1.2.79, schema on #691): one STL per printable part per copy, in the 3MF's build
 * frame in millimetres, so every part lines up when drawn together, each with its name, plate, filament and colour.
 * The MCP advertises it as `capabilities.partMeshes` in `counterpart_printer_info`, and the tool exists exactly when it
 * does; the tool being listed is the gate, so drawing parts never waits on the printer answering. Counterpart reads no
 * 3MF geometry itself (PRD §8.0): without the tool the design is drawn as today, its merged mesh in the neutral material.
 */
export const PART_MESHES_TOOL = 'counterpart_part_meshes';

/**
 * One part as the MCP meshed it. `id` is the MCP's key (`"<build item>/<object id>"`), kept as given and never parsed.
 * `plate` is 0-based here (the MCP's plate number minus one, as `list_3mf_plates`' `index`); absent for a plain 3MF.
 * `colour` is the 3MF's own filament colour, absent when the file declares none. `stlPath` is inside the call's folder.
 */
export interface McpModelPart {id: string; name?: string; filament?: number; colour?: string; plate?: number; painted?: boolean; stlPath: string}

const MAX_PARTS = 256;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || undefined : undefined;
const within = (path: string, dir: string) => resolve(path).startsWith(resolve(dir) + sep);

/**
 * The tool's structured answer: its parts, and the names of any it skipped. `undefined` when it isn't an answer this
 * version can read. `skipped` names parts the MCP couldn't mesh (over its bounds): a design is drawn with all of its
 * parts or as one piece, never with some missing, so the caller treats any skipped part as no parts.
 */
export function modelPartsFrom(structuredContent: unknown, outDir: string): {parts: McpModelPart[]; skipped: string[]} | undefined {
  // String keys: services/companion/tests/mcp-contract.test.mjs holds every MCP name the app reads to the contract doc.
  if (!record(structuredContent) || !Array.isArray(structuredContent['parts']) || structuredContent['units'] !== 'mm') return undefined;
  const folder = structuredContent['folder'];
  if (typeof folder !== 'string' || !within(folder, outDir)) return undefined;
  const list = structuredContent['parts'] as unknown[];
  if (!list.length || list.length > MAX_PARTS) return undefined;
  const parts: McpModelPart[] = [];
  for (const part of list) {
    if (!record(part)) return undefined;
    const id = text(part['id'], 64), path = part['stl_path'], filament = part['filament'], colour = part['color'], plate = part['plate'];
    if (!id || typeof path !== 'string' || !within(path, folder) || !path.toLowerCase().endsWith('.stl')) return undefined;
    const name = text(part['name'], 128);
    parts.push({id, stlPath: resolve(path), ...(name ? {name} : {}),
      ...(Number.isSafeInteger(filament) && (filament as number) >= 1 && (filament as number) <= 64 ? {filament: filament as number} : {}),
      ...(typeof colour === 'string' && /^#[0-9A-Fa-f]{6}$/.test(colour) ? {colour: colour.toUpperCase()} : {}),
      ...(Number.isSafeInteger(plate) && (plate as number) >= 1 && (plate as number) <= 1000 ? {plate: (plate as number) - 1} : {}),
      ...(part['painted'] === true ? {painted: true} : {})});
  }
  if (new Set(parts.map(part => part.id)).size !== parts.length) return undefined;
  const skipped = Array.isArray(structuredContent['skipped'])
    ? (structuredContent['skipped'] as unknown[]).map(item => (record(item) ? text(item['name'], 128) ?? text(item['id'], 64) : undefined) ?? 'a part')
    : [];
  return {parts, skipped};
}
