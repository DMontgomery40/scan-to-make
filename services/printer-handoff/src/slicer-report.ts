/**
 * Bambu Studio's own verdict on a slice. bambu-printer-mcp's `slice_stl` returns the CLI's
 * `<outputdir>/result.json`, parsed verbatim, as `structuredContent.slicer_result`; an older MCP
 * returns only the path, and then there is no report.
 *
 * result.json carries `return_code` (0 on success), `error_string`, and per plate
 * `sliced_plates[].warning_message`: the words Studio shows the user, such as "It seems object
 * x.stl has floating cantilever. Please re-orient the object or enable support generation."
 */
export interface SlicerReport {
  /** Studio refused the slice: nothing may be printed from it. */
  failed: boolean;
  /** Studio's own words, verbatim: the error and its plates' messages, or the warnings of a slice that worked. */
  message?: string;
  /** Number of distinct output plates explicitly identified by the slicer. */
  plateCount?: number;
}

const MAX_MESSAGE = 2000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Line breaks stay (Studio lists one empty layer per line); other control characters go.
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').trim();

/** The report in a `slice_stl` result's structured content, or undefined when the MCP gave none. */
export function slicerReport(structuredContent: unknown): SlicerReport | undefined {
  const result = record(structuredContent) ? structuredContent.slicer_result : undefined;
  if (!record(result)) return undefined;
  const plates = Array.isArray(result.sliced_plates) ? result.sliced_plates : [];
  const ids = plates.map(plate => record(plate) ? plate.id : undefined);
  const plateCount = ids.length && ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    ? new Set(ids).size : undefined;
  const warnings = plates.map(plate => record(plate) && typeof plate.warning_message === 'string' ? clean(plate.warning_message) : '')
    .filter(Boolean);
  // Anything but Studio's success code fails closed, a missing one included.
  const failed = result.return_code !== 0;
  const error = typeof result.error_string === 'string' ? clean(result.error_string) : '';
  const words = [...new Set([...(failed && error ? [error] : []), ...warnings])].join('\n').slice(0, MAX_MESSAGE);
  if (failed) return {failed, message: words || `Bambu Studio could not slice this model (return code ${String(result.return_code)}).`};
  return {failed, ...(words ? {message: words} : {}), ...(plateCount ? {plateCount} : {})};
}
