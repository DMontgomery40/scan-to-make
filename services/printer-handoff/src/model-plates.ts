/**
 * A designer's 3MF plates, as the printer MCP lists them before slicing (`list_3mf_plates`, bambu-printer-mcp 1.1.69+,
 * mcp-3d-printer-server 1.2.49+). Counterpart doesn't read a project's plate metadata itself (PRD §8.0 item 9): the
 * plates the person picks from are the ones Bambu Studio shows for the same file.
 */
/**
 * One project filament as the MCP lists it (list_3mf_plates `filaments` / `project_filaments`, bambu-printer-mcp
 * 1.1.73+, mcp-3d-printer-server 1.2.53+): `index` from 1 is its slice_stl load_filaments position and its
 * print_3mf ams_mapping position + 1. Which filaments a plate prints is the MCP's to say (PRD §8.0).
 */
export interface McpPlateFilament {index: number; colour?: string; material?: string; filamentId?: string; name?: string}

export interface McpModelPlate {
  /** Zero-based, as inspect_print_file's plate_index; slice_stl's slice_plate is index + 1. */
  index: number;
  name: string;
  objects: string[];
  /** The file already holds this plate's G-code. */
  sliced: boolean;
  /** The plate's own preview from the file, PNG bytes. */
  thumbnail?: Buffer;
  /** The filaments this plate prints, and only those; absent from an MCP older than per-plate filaments. */
  filaments?: McpPlateFilament[];
}
export interface McpModelPlates {plates: McpModelPlate[]; title?: string; designer?: string; licence?: string;
  /** Every filament the project declares, used or not (slice_stl takes one profile each); absent from an older MCP. */
  projectFilaments?: McpPlateFilament[]}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : undefined;

/** A filament list as the MCP gives it; undefined when it isn't one. */
function filamentsFrom(value: unknown): McpPlateFilament[] | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const filaments: McpPlateFilament[] = [];
  for (const item of value) {
    if (!record(item) || !Number.isSafeInteger(item.index) || (item.index as number) < 1 || (item.index as number) > 64) return undefined;
    const colour = typeof item.colour === 'string' && /^#[0-9A-Fa-f]{6}$/.test(item.colour) ? item.colour.toUpperCase() : undefined;
    const material = text(item.material, 64), filamentId = text(item['filament_id'], 64), name = text(item.name, 256);
    filaments.push({index: item.index as number, ...(colour ? {colour} : {}), ...(material ? {material} : {}), ...(filamentId ? {filamentId} : {}), ...(name ? {name} : {})});
  }
  return new Set(filaments.map(filament => filament.index)).size === filaments.length ? filaments.sort((a, b) => a.index - b.index) : undefined;
}

/** The MCP's answer, checked field by field; undefined when it isn't one. */
export function modelPlatesFrom(structuredContent: unknown): McpModelPlates | undefined {
  // String keys: services/companion/tests/mcp-contract.test.mjs holds every MCP name the app reads to the contract doc.
  if (!record(structuredContent) || !Array.isArray(structuredContent['plates'])) return undefined;
  const list = structuredContent['plates'] as unknown[];
  if (!list.length || list.length > 1000) return undefined;
  const plates: McpModelPlate[] = [];
  for (const plate of list) {
    if (!record(plate) || !Number.isSafeInteger(plate.index) || (plate.index as number) < 0 || typeof plate.sliced !== 'boolean') return undefined;
    const png = typeof plate['thumbnail_png_base64'] === 'string' ? Buffer.from(plate['thumbnail_png_base64'], 'base64') : undefined;
    const filaments = Object.hasOwn(plate, 'filaments') ? filamentsFrom(plate.filaments) : undefined;
    if (Object.hasOwn(plate, 'filaments') && !filaments) return undefined;
    plates.push({index: plate.index as number, name: text(plate.name, 120) || `Plate ${(plate.index as number) + 1}`, ...(filaments ? {filaments} : {}),
      objects: Array.isArray(plate.objects) ? plate.objects.flatMap(item => text(item, 120) ? [text(item, 120)!] : []).slice(0, 200) : [],
      sliced: plate.sliced, ...(png && png.length <= 2 * 1024 * 1024 && png.subarray(0, 8).equals(PNG) ? {thumbnail: png} : {})});
  }
  if (new Set(plates.map(plate => plate.index)).size !== plates.length) return undefined;
  const title = text(structuredContent.title, 256), designer = text(structuredContent.designer, 256), licence = text(structuredContent.licence, 256);
  const projectFilaments = Object.hasOwn(structuredContent, 'project_filaments') ? filamentsFrom(structuredContent['project_filaments']) : undefined;
  if (Object.hasOwn(structuredContent, 'project_filaments') && !projectFilaments) return undefined;
  return {plates: plates.sort((a, b) => a.index - b.index), ...(projectFilaments ? {projectFilaments} : {}), ...(title ? {title} : {}), ...(designer ? {designer} : {}), ...(licence ? {licence} : {})};
}
