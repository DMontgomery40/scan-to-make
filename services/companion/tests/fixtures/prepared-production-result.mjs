import {createHash} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const fakeSlicedThreeMf = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fixture sliced 3mf'),
]);

export function fakeProductionSettings(request) {
  const selection = request.selection;
  return Buffer.from(JSON.stringify({
    schema: 'scan-to-make.bambu-slice-settings/0.1.0',
    tool: 'slice_stl',
    slicerType: 'bambustudio',
    bambuModel: selection.model,
    nozzleDiameter: String(selection.nozzleDiameters[0]),
    bedType: selection.bedType,
    nozzleType: selection.nozzleType,
    plateIndex: selection.plateIndex,
    allowSupports: request.allowSupports,
    usePrinterFilaments: false,
    orient: true,
    arrange: true,
    ensureOnBed: true,
  }) + '\n');
}

export function fakeProductionResult(input, request) {
  const printable = Buffer.from(fakeSlicedThreeMf);
  const settings = fakeProductionSettings(request);
  const manifest = Buffer.from(JSON.stringify({
    schema: 'scan-to-make.bambu-slice/0.1.0',
    tool: 'slice_stl',
    server: {name: 'slice-fixture', version: '1.1.41'},
    catalogSha256: 'a'.repeat(64),
    input: {sha256: sha(input), bytes: input.length},
    outputs: {
      threeMf: {file: 'source_sliced.3mf', sha256: sha(printable), bytes: printable.length},
      settings: {file: 'settings.json', sha256: sha(settings), bytes: settings.length},
    },
  }) + '\n');
  return {printable, settings, manifest};
}
