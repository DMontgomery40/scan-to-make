/**
 * The printer MCP's verdict on a slice: `slicer_report` in a slicing tool's structured content (bambu-printer-mcp
 * 1.1.64+, mcp-3d-printer-server 1.2.42+), read from the slicer's own result. Counterpart never reads the slicer's
 * formats (PRD §8.0 item 9).
 */
export interface SlicerReport {
  /** The slicer refused the slice: nothing may be printed from it. */
  failed: boolean;
  /** The slicer's own words, verbatim: the error and its plates' messages, or the warnings of a slice that worked. */
  message?: string;
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
  const plates = report['plate_count'];
  return {failed: report.failed, ...(message ? {message} : {}),
    ...(typeof plates === 'number' && Number.isSafeInteger(plates) && plates > 0 ? {plateCount: plates} : {})};
}

/** A slicing result from an MCP that passes the slicer's result.json but not yet its verdict: Update. */
export function lacksSlicerReport(structuredContent: unknown): boolean {
  return record(structuredContent) && structuredContent['slicer_result'] !== undefined && structuredContent['slicer_report'] === undefined;
}
