import {resolve, sep} from 'node:path';

/**
 * #691: a 3MF's parts as the printer MCP meshes them, one STL per part in its object's frame (millimetres), each with
 * its name, filament and colour, so every client can draw a multi-colour design in its colours. Counterpart reads no
 * 3MF geometry itself (PRD §8.0): without the tool the design is drawn as today, its merged mesh in the neutral material.
 *
 * STUB until the MCP implementer posts the counterpart/1 schema on #691: the tool and field names below are the only
 * place it is spelled, so the real names replace these here.
 */
export const MODEL_PARTS_TOOL = 'counterpart_model_parts';

/**
 * One part as the MCP meshed it. `stlPath` is inside the output folder Counterpart gave the call. `plate`: the 0-based
 * plate it is on, when the file has plates (a designer's kit), so a client draws only the chosen plate's parts.
 */
export interface McpModelPart {id: string; name?: string; filament?: number; colour?: string; plate?: number; stlPath: string}

const MAX_PARTS = 64;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || undefined : undefined;

/**
 * The tool's structured answer, or undefined when it isn't one this version can read (then nothing is drawn per part).
 * Every mesh must be inside `outputDir`; ids are file-name safe and unique; colours are #RRGGBB.
 */
export function modelPartsFrom(structuredContent: unknown, outputDir: string): McpModelPart[] | undefined {
  // String keys: services/companion/tests/mcp-contract.test.mjs holds every MCP name the app reads to the contract doc.
  if (!record(structuredContent) || !Array.isArray(structuredContent['parts'])) return undefined;
  const list = structuredContent['parts'] as unknown[];
  if (!list.length || list.length > MAX_PARTS) return undefined;
  const root = resolve(outputDir) + sep, parts: McpModelPart[] = [];
  for (const part of list) {
    if (!record(part)) return undefined;
    const id = part['id'], path = part['stl_path'], filament = part['filament'], colour = part['colour'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
    if (typeof path !== 'string' || !resolve(path).startsWith(root) || !path.toLowerCase().endsWith('.stl')) return undefined;
    const name = text(part['name'], 128);
    parts.push({id, stlPath: resolve(path), ...(name ? {name} : {}),
      ...(Number.isSafeInteger(filament) && (filament as number) >= 1 && (filament as number) <= 64 ? {filament: filament as number} : {}),
      ...(typeof colour === 'string' && /^#[0-9A-Fa-f]{6}$/.test(colour) ? {colour: colour.toUpperCase()} : {}),
      ...(Number.isSafeInteger(part['plate']) && (part['plate'] as number) >= 0 && (part['plate'] as number) < 1000 ? {plate: part['plate'] as number} : {})});
  }
  if (new Set(parts.map(part => part.id)).size !== parts.length) return undefined;
  return parts;
}
