// Print sends the sliced file the print sheet showed (Nov 5): an estimate's `sliceSha256`, drawn by the MCP's
// inspect_print_file preview. These helpers let tests about other things print the way the sheet does.
import {createHash} from 'node:crypto';

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
  const estimate = runner.estimate;
  let n = 0;
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
