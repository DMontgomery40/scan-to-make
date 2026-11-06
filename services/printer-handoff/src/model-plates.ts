/**
 * A designer's 3MF plates, as the printer MCP lists them before slicing (`list_3mf_plates`, bambu-printer-mcp 1.1.69+,
 * mcp-3d-printer-server 1.2.49+). Counterpart doesn't read a project's plate metadata itself (PRD §8.0 item 9): the
 * plates the person picks from are the ones Bambu Studio shows for the same file.
 */
export interface McpModelPlate {
  /** Zero-based, as inspect_print_file's plate_index; slice_stl's slice_plate is index + 1. */
  index: number;
  name: string;
  objects: string[];
  /** The file already holds this plate's G-code. */
  sliced: boolean;
  /** The plate's own preview from the file, PNG bytes. */
  thumbnail?: Buffer;
}
export interface McpModelPlates {plates: McpModelPlate[]; title?: string; designer?: string; licence?: string}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : undefined;

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
    plates.push({index: plate.index as number, name: text(plate.name, 120) || `Plate ${(plate.index as number) + 1}`,
      objects: Array.isArray(plate.objects) ? plate.objects.flatMap(item => text(item, 120) ? [text(item, 120)!] : []).slice(0, 200) : [],
      sliced: plate.sliced, ...(png && png.length <= 2 * 1024 * 1024 && png.subarray(0, 8).equals(PNG) ? {thumbnail: png} : {})});
  }
  if (new Set(plates.map(plate => plate.index)).size !== plates.length) return undefined;
  const title = text(structuredContent.title, 256), designer = text(structuredContent.designer, 256), licence = text(structuredContent.licence, 256);
  return {plates: plates.sort((a, b) => a.index - b.index), ...(title ? {title} : {}), ...(designer ? {designer} : {}), ...(licence ? {licence} : {})};
}
