/**
 * What the printer MCP's `inspect_print_file` says about the exact sliced file (`sliced`, bambu-printer-mcp 1.1.64+,
 * mcp-3d-printer-server 1.2.42+): the selected plate's estimate and slice settings and the file's plate count.
 * Counterpart never reads slicer files for them (PRD §8.0 item 9); an MCP without them gives no estimate.
 */
export interface SliceEstimate { seconds?: number; grams?: number }
export interface SliceSettings { layerHeightMm?: number; infillPercent?: number; wallLoops?: number; layers?: number }
export interface SlicedFacts { plateCount?: number; estimate?: SliceEstimate; settings: SliceSettings }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown, integer = false) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;

export function slicedFacts(receipt: unknown): SlicedFacts {
  const sliced = record(receipt) && record(receipt.sliced) ? receipt.sliced : {};
  const estimate = record(sliced.estimate) ? sliced.estimate : {};
  const settings = record(sliced.settings) ? sliced.settings : {};
  const seconds = amount(estimate.seconds), grams = amount(estimate.grams);
  // String keys: services/companion/tests/mcp-contract.test.mjs holds every MCP name the app reads to the contract doc.
  const plates = amount(sliced['plate_count'], true);
  const values: SliceSettings = {layerHeightMm: amount(settings['layer_height_mm']), infillPercent: amount(settings['sparse_infill_percent']),
    wallLoops: amount(settings['wall_loops'], true), layers: amount(settings['layer_count'], true)};
  return {
    ...(plates ? {plateCount: plates} : {}),
    ...(seconds !== undefined || grams !== undefined ? {estimate: {...(seconds !== undefined ? {seconds} : {}), ...(grams !== undefined ? {grams} : {})}} : {}),
    settings: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as SliceSettings,
  };
}
