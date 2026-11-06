// Print sends the sliced file the print sheet showed (Nov 5): an estimate's `sliceSha256`, drawn by the MCP's
// inspect_print_file preview. These helpers let tests about other things print the way the sheet does.
import {createHash} from 'node:crypto';
import {proposingRunner} from './mcp-filaments.mjs';
import {readFile} from 'node:fs/promises';
import {inspectModelFile, modelPlatePreview} from '@scan-to-make/printer-handoff';

/**
 * The printer MCP's list_3mf_plates, as a stand-in reads them (bambu-printer-mcp src/counterpart/model-plates.ts):
 * the runner's modelPlates. Counterpart itself reads no plate metadata.
 */
export async function mcpPlates({modelPath}) {
  const bytes = await readFile(modelPath);
  const info = inspectModelFile(bytes, '3mf');
  return {plates: info.plates.map(plate => {
    const thumbnail = modelPlatePreview(bytes, plate.index);
    return {index: plate.index, name: plate.name, objects: plate.objects, sliced: plate.sliced, ...(thumbnail ? {thumbnail} : {})};
  }), ...(info.title ? {title: info.title} : {}), ...(info.designer ? {designer: info.designer} : {})};
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC', 'base64');

/** A sliced file and the MCP's preview of it, as a real estimate returns them. */
export function shownSlice(label = 'sliced') {
  const bytes = Buffer.from(`PK\x03\x04 ${label}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const view = name => ({name, label: name === 'top' ? 'Top, as it sits on the bed' : 'Bed side, turned over toward you', png: PNG.toString('base64'), width: 1, height: 1});
  return {sliced: {bytes, extension: '.3mf', sha256}, preview: {sha256, views: [view('top'), view('bed_side')]}};
}

// While `showing` opens the sheet for a test about something else, its estimate leaves the test's fakes alone.
let sheetOnly = 0;

/** A runner whose estimate also returns a sliced file and its preview (adding an estimate when it has none). */
export function showingRunner(runner, {preview = true} = {}) {
  // A runner that fakes the printer's spools also answers the MCP's spool proposal from them.
  proposingRunner(runner);
  const estimate = runner.estimate;
  let n = 0;
  // An MCP that lists a 3MF's plates (1.1.69+), unless the test gives its own, or none (`modelPlates: undefined`).
  if (!Object.hasOwn(runner, 'modelPlates')) runner.modelPlates = mcpPlates;
  return Object.assign(runner, {estimate: async input => {
    const result = sheetOnly || !estimate ? {estimate: {seconds: 60, grams: 1}, settings: {}} : await estimate(input);
    const shown = shownSlice(`slice ${++n}`);
    const out = {...shown, previewSupported: preview, ...result};
    if (!preview) { delete out.preview; out.previewSupported = false; }
    return out;
  }});
}

/** The service, printing as the sheet does: estimate (and preview) first, then Print with that slice's hash. */
export function showing(service) {
  const print = service.print.bind(service);
  service.printUnshown = print;
  service.print = async (id, options = {}) => {
    if (options.sliceSha256) return print(id, options);
    // The sheet's estimate gets every choice Print gets: it slices exactly what Print would send.
    const {checked: _checked, expectedPlate: _plate, ...choices} = options;
    sheetOnly++;
    const estimate = await service.estimate(id, choices).finally(() => { sheetOnly--; });
    return print(id, {...options, sliceSha256: estimate.sliceSha256});
  };
  return service;
}

/** list_3mf_plates as an MCP tool result, for fake sessions (thumbnails as base64, as the MCPs send them). */
export async function mcpPlatesResult(threeMfPath) {
  const listed = await mcpPlates({modelPath: threeMfPath});
  const value = {plate_count: listed.plates.length, ...listed, plates: listed.plates.map(({thumbnail, ...plate}) => ({...plate, ...(thumbnail ? {thumbnail_png_base64: thumbnail.toString('base64')} : {})}))};
  return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
}
