import {createHash} from 'node:crypto';
import {z} from 'zod';
import {type ArtifactRef} from '@scan-to-make/contracts';
import {PrintSelectionSchema} from './index.js';
import {inspectPreparedFile, type TrustedMcpProcess, type DiscoveryOptions} from './mcp-discovery.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nozzles = z.array(z.literal([0.2, 0.4, 0.6, 0.8])).min(1).max(2);
const receiptSchema = z.strictObject({
  receipt_version: z.literal('1'), evidence: z.literal('file-only'), dispatch_authorized: z.literal(false),
  artifact: z.strictObject({sha256: digest, byte_length: integer, file_format: z.enum(['3mf', 'gcode'])}),
  selection: z.strictObject({bambu_model: z.string(), plate_index: integer, nozzle_diameters: nozzles, bed_type: z.string()}),
  inspection: z.strictObject({model: z.string(), nozzleDiameters: nozzles,
    materials: z.array(z.string().min(1)).min(1).max(256), usedFilamentPositions: z.array(integer).min(1).max(256),
    plateInternalPath: z.string().optional(), sha256: digest,
    maxNozzleTemperature: z.number().nonnegative(), maxBedTemperature: z.number().nonnegative(),
    maxChamberTemperature: z.number().nonnegative(), bedType: z.string(), selectsAms: z.boolean(),
    nozzleTypes: z.array(z.string()).max(2).optional(), nozzleFlows: z.array(z.string()).max(2).optional(),
  }),
});
export const PreparedInspectionSchema = z.strictObject({
  receipt: receiptSchema, catalogSha256: digest,
  server: z.strictObject({name: z.string().max(512), version: z.string().max(512)}),
});
export interface PreparedInspectionConfiguration {process: TrustedMcpProcess; options?: DiscoveryOptions}
const beds = {textured_plate: 'textured pei plate', cool_plate: 'cool plate', engineering_plate: 'engineering plate',
  hot_plate: 'smooth pei plate', supertack_plate: 'cool plate supertack'};
export function printableFormat(artifact: ArtifactRef): '3mf' | 'gcode' {
  if (artifact.mediaType === 'model/3mf') return '3mf';
  if (artifact.mediaType === 'text/x.gcode') return 'gcode';
  throw new Error('Inspected preparation requires sliced model/3mf or text/x.gcode');
}
function compatible(receiptInput: unknown, artifact: ArtifactRef, selection: z.infer<typeof PrintSelectionSchema>) {
  const receipt = receiptSchema.parse(receiptInput), actual = receipt.inspection;
  const expected = {bambu_model: selection.model, plate_index: selection.plateIndex,
    nozzle_diameters: selection.nozzleDiameters, bed_type: selection.bedType};
  if (receipt.artifact.sha256 !== artifact.sha256 || actual.sha256 !== artifact.sha256 ||
      receipt.artifact.byte_length !== artifact.byteLength || receipt.artifact.file_format !== printableFormat(artifact) ||
      JSON.stringify(receipt.selection) !== JSON.stringify(expected) || actual.model !== selection.model ||
      actual.bedType !== beds[selection.bedType] ||
      (selection.nozzleDiameters.length === 1 ? actual.nozzleDiameters.some(n => n !== selection.nozzleDiameters[0]) :
        JSON.stringify(actual.nozzleDiameters) !== JSON.stringify(selection.nozzleDiameters))) {
    throw new Error('File inspection does not match the retained bytes and selection');
  }
  if (receipt.artifact.file_format === '3mf' ? actual.plateInternalPath !== `Metadata/plate_${selection.plateIndex + 1}.gcode` :
      selection.plateIndex !== 0 || actual.plateInternalPath !== undefined) throw new Error('Inspected plate mismatch');
  const positions = actual.usedFilamentPositions;
  if (new Set(positions).size !== positions.length || positions.length !== selection.materials.length) throw new Error('Inspected material positions mismatch');
  const slots = positions.map(position => {
    const material = selection.materials.find(m => m.projectSlot === position);
    // Canonical material family is explicit; do not guess aliases or physical inventory.
    if (!material || material.material !== actual.materials[position] || material.physicalTray > 254 || (material.physicalTray > 15 && material.physicalTray < 128)) throw new Error('Inspected material mapping mismatch');
    return material.physicalTray;
  });
  const external = slots.includes(254);
  if (external && (slots.length !== 1 || actual.selectsAms)) throw new Error('External material selection contradicts inspected AMS use');
  const mapping = actual.materials.map(() => -1);
  positions.forEach((position, index) => { mapping[position] = slots[index]!; });
  return {receipt, mapping, useAms: !external};
}
/** Operator-configured inspector, never a receipt or executable supplied by a remote request. */
export function createPreparedFileInspector(configuration: PreparedInspectionConfiguration) {
  const process = structuredClone(configuration.process);
  const options = {...configuration.options};
  return async (file: string, artifact: ArtifactRef, selection: z.infer<typeof PrintSelectionSchema>, signal?: AbortSignal) => {
    const result = await inspectPreparedFile(process, {file_path: file, bambu_model: selection.model,
      plate_index: selection.plateIndex, nozzle_diameters: selection.nozzleDiameters, bed_type: selection.bedType}, receipt => {
      const checked = compatible(receipt, artifact, selection);
      return {three_mf_path: file, bambu_model: selection.model, plate_index: selection.plateIndex,
        nozzle_diameters: selection.nozzleDiameters, bed_type: selection.bedType,
        use_ams: checked.useAms, ams_mapping: checked.mapping};
    }, {...options, signal: signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal});
    return PreparedInspectionSchema.parse({receipt: compatible(result.receipt, artifact, selection).receipt,
      catalogSha256: createHash('sha256').update(JSON.stringify(result.catalog)).digest('hex'), server: result.catalog.server});
  };
}
