/**
 * The printer MCP's verdict on a slice: `slicer_report` in a slicing tool's structured content (bambu-printer-mcp
 * 1.1.64+, mcp-3d-printer-server 1.2.42+), read from the slicer's own result. Counterpart never reads the slicer's
 * formats (PRD §8.0 item 9). A refusal's `message` is the MCP's plain sentence (bambu-printer-mcp 1.1.67+); the
 * slicer's own words are `slicer_message`, kept for the log.
 */
export interface SlicerReport {
  /** The slicer refused the slice: nothing may be printed from it. */
  failed: boolean;
  /** What the person is told: the MCP's plain sentence for a refusal, or the warnings of a slice that worked. */
  message?: string;
  /** The slicer's own words, verbatim, for the log; never shown as they are. */
  slicerMessage?: string;
  /** Number of distinct output plates the slicer identified. */
  plateCount?: number;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The report in a slicing result's structured content, or undefined when the MCP gave none. */
export function slicerReport(structuredContent: unknown): SlicerReport | undefined {
  // String keys: services/companion/tests/mcp-contract.test.mjs holds every MCP name the app reads to the contract doc.
  const report = record(structuredContent) ? structuredContent['slicer_report'] : undefined;
  if (!record(report) || typeof report.failed !== 'boolean') return undefined;
  const message = typeof report.message === 'string' && report.message.trim() ? report.message.slice(0, 2000) : undefined;
  const words = report['slicer_message'];
  const slicerMessage = typeof words === 'string' && words.trim() ? words.slice(0, 2000) : undefined;
  const plates = report['plate_count'];
  return {failed: report.failed, ...(message ? {message} : {}), ...(slicerMessage ? {slicerMessage} : {}),
    ...(typeof plates === 'number' && Number.isSafeInteger(plates) && plates > 0 ? {plateCount: plates} : {})};
}

/** A slicing result from an MCP that passes the slicer's result.json but not yet its verdict: Update. */
export function lacksSlicerReport(structuredContent: unknown): boolean {
  return record(structuredContent) && structuredContent['slicer_result'] !== undefined && structuredContent['slicer_report'] === undefined;
}

/** A plate split of a model bigger than the bed: slice_stl's `bed_split`, when the MCP arranged it on plates. */
export interface BedSplit {
  /** The multi-plate project 3MF the MCP wrote. */
  path: string;
  /** Its plates, as the MCP lists them: zero-based index, name and objects. */
  plates: {index: number; name: string; objects: string[]}[];
  /** The MCP's sentence for the person. */
  message: string;
}

/** The split in a slicing result's structured content, or undefined when the model fit (or the MCP didn't split). */
export function bedSplit(structuredContent: unknown): BedSplit | undefined {
  const split = record(structuredContent) ? structuredContent['bed_split'] : undefined;
  if (!record(split) || split.fits !== false) return undefined;
  const path = split['three_mf_path'];
  if (typeof path !== 'string' || !path || !Array.isArray(split.plates) || !split.plates.length || split.plates.length > 100) return undefined;
  const plates = split.plates.flatMap((plate: unknown, position: number) => record(plate) && plate.index === position && typeof plate.name === 'string'
    ? [{index: position, name: plate.name.slice(0, 120), objects: Array.isArray(plate.objects) ? plate.objects.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 120)).slice(0, 200) : []}] : []);
  if (plates.length !== split.plates.length) return undefined;
  const message = typeof split.message === 'string' ? split.message.slice(0, 1000) : '';
  return {path, plates, message};
}
