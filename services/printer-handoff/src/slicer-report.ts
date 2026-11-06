/**
 * The printer MCP's verdict on a slice: `slicer_report` in a slicing tool's structured content (bambu-printer-mcp
 * 1.1.64+, mcp-3d-printer-server 1.2.42+), read from the slicer's own result. Counterpart never reads the slicer's
 * formats (PRD §8.0 item 9).
 */
export interface SlicerReport {
  /** The slicer refused the slice: nothing may be printed from it. */
  failed: boolean;
  /** The MCP's words for a person: a plain sentence for a refusal (1.1.69+), or the warnings of a slice that worked. */
  message?: string;
  /** The slicer's own words, verbatim (`slicer_message`, bambu-printer-mcp 1.1.69+): for the log, never shown. */
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
  const slicerMessage = typeof words === 'string' && words.trim() ? words.slice(0, 4000) : undefined;
  const plates = report['plate_count'];
  return {failed: report.failed, ...(message ? {message} : {}), ...(slicerMessage ? {slicerMessage} : {}),
    ...(typeof plates === 'number' && Number.isSafeInteger(plates) && plates > 0 ? {plateCount: plates} : {})};
}

/** A slicing result from an MCP that passes the slicer's result.json but not yet its verdict: Update. */
export function lacksSlicerReport(structuredContent: unknown): boolean {
  return record(structuredContent) && structuredContent['slicer_result'] !== undefined && structuredContent['slicer_report'] === undefined;
}

/**
 * A refusal's slicer words go to the companion's log (its stderr), where a person's "kept for the log" sentence points:
 * the MCP gives a person a plain sentence and keeps the slicer's own words in `slicer_message`.
 */
export function logSlicerRefusal(report: SlicerReport, log: (line: string) => void = line => console.error(line)): void {
  if (!report.failed) return;
  const words = (report.slicerMessage ?? report.message ?? '').replace(/\s+/g, ' ').trim();
  log(`slicer refused the slice: ${words || 'the MCP gave no slicer message'}`);
}
