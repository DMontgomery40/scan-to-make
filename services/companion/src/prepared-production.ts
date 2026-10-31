import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ArtifactRefSchema} from '@scan-to-make/contracts';
import {slicePreparedStl, type TrustedMcpProcess} from './mcp-discovery.js';
import {inspectorProcessSchema} from './private-config.js';

export const PRODUCTION_LIMITS = {sourceBytes:32*1024*1024, settingsBytes:8*1024*1024, manifestBytes:1024*1024};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const printabilityRecord=z.strictObject({
 profileId:z.string().min(1).max(128),
 verdict:z.enum(['printable','printable-with-supports']),
 allowSupports:z.boolean(),
 reportArtifact:ArtifactRefSchema,
});
// Retained jobs produced by the removed local slicer wrapper keep loading and
// reverifying; new production emits the bambu-printer-mcp record below.
const LegacyPreparedProductionSchema=z.strictObject({
 requestSha256:digest, producerIdentity:digest, sourceArtifact:ArtifactRefSchema,
 settingsArtifact:ArtifactRefSchema, manifestArtifact:ArtifactRefSchema,
 slicer:z.strictObject({version:z.string().min(1).max(128),binarySha256:digest}),
 printability:printabilityRecord.optional(),
});
export const producerSlicerTypeSchema=z.enum(['bambustudio','orcaslicer','orcaslicer-bambulab','fulu-orca','orca-studio']);
export type ProducerSlicerType=z.infer<typeof producerSlicerTypeSchema>;
const McpPreparedProductionSchema=z.strictObject({
 producerKind:z.literal('bambu-printer-mcp'),
 requestSha256:digest, producerIdentity:digest, sourceArtifact:ArtifactRefSchema,
 settingsArtifact:ArtifactRefSchema, manifestArtifact:ArtifactRefSchema,
 mcpServer:z.strictObject({name:z.string().min(1).max(512),version:z.string().min(1).max(512)}),
 catalogSha256:digest,
 tool:z.literal('slice_stl'),
 slicerType:producerSlicerTypeSchema,
 printability:printabilityRecord.optional(),
});
export const PreparedProductionSchema=z.union([McpPreparedProductionSchema,LegacyPreparedProductionSchema]);
export type PreparedProduction=z.infer<typeof PreparedProductionSchema>;
export interface ProductionBytes {printable:Buffer;settings:Buffer;manifest:Buffer}
export interface PreparedProducerSelection {
 printerId:string;
 model:string;
 plateIndex:number;
 nozzleDiameters:readonly number[];
 bedType:string;
 nozzleType:ProducerNozzleType;
 materials:readonly {projectSlot:number;material:string;physicalTray:number}[];
}
export interface PreparedProducerRequest {
 selection:PreparedProducerSelection;
 allowSupports:boolean;
}
/** Trusted host capability, configured at construction; never supplied by a remote request. */
export interface PreparedProducer {
 readonly identity:string;
 produce(source:Buffer,request:PreparedProducerRequest,signal?:AbortSignal):Promise<ProductionBytes>;
}
export function productionHash(bytes:Uint8Array|string):string{return createHash('sha256').update(bytes).digest('hex');}
export function productionRef(bytes:Buffer,mediaType:string){return {sha256:productionHash(bytes),byteLength:bytes.length,mediaType};}
const outputRef=z.object({file:z.string(),sha256:digest,bytes:z.number().int().positive()});
const legacyManifestSchema=z.object({
 schema:z.literal('scan-to-make.slicer-producer/0.1.0'),operatorOnly:z.literal(true),exitCode:z.literal(0),
 slicer:z.object({version:z.string().min(1).max(128),binary:z.object({sha256:digest})}),
 input:z.object({sha256:digest,bytes:z.number().int().positive(),expectedDigestChecked:z.literal(true)}),
 invocation:z.object({sandbox:z.object({kind:z.literal('macos-sandbox-exec'),path:z.literal('/usr/bin/sandbox-exec')})}),
 outputs:z.object({gcode:outputRef,exportedSettings:outputRef}),
});
const sliceSettingsSchema=z.strictObject({
 schema:z.literal('scan-to-make.bambu-slice-settings/0.1.0'),
 tool:z.literal('slice_stl'),
 slicerType:producerSlicerTypeSchema,
 bambuModel:z.string().min(1).max(128),
 nozzleDiameter:z.enum(['0.2','0.4','0.6','0.8']),
 bedType:z.enum(['textured_plate','cool_plate','engineering_plate','hot_plate','supertack_plate']),
 nozzleType:z.enum(['stainless_steel','hardened_steel','tungsten_carbide','brass']),
 plateIndex:integer,
 allowSupports:z.boolean(),
 usePrinterFilaments:z.literal(false),
 orient:z.literal(true),
 arrange:z.literal(true),
 ensureOnBed:z.literal(true),
});
const mcpManifestSchema=z.strictObject({
 schema:z.literal('scan-to-make.bambu-slice/0.1.0'),
 tool:z.literal('slice_stl'),
 server:z.strictObject({name:z.string().min(1).max(512),version:z.string().min(1).max(512)}),
 catalogSha256:digest,
 input:z.strictObject({sha256:digest,bytes:z.number().int().positive()}),
 outputs:z.strictObject({threeMf:outputRef,settings:outputRef}),
});
export function verifyProductionBytes(source:Buffer,input:ProductionBytes,maxPrintableBytes:number){
 for(const [name,bytes,max] of [['source',source,PRODUCTION_LIMITS.sourceBytes],['printable',input.printable,maxPrintableBytes],['settings',input.settings,PRODUCTION_LIMITS.settingsBytes],['manifest',input.manifest,PRODUCTION_LIMITS.manifestBytes]] as const){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max)throw new Error(`Produced ${name} byte limit exceeded`);
 }
 const settings=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.settings));
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error('Produced settings must be an object');
 const rawManifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.manifest)) as {schema?:unknown};
 const matches=(ref:{sha256:string;bytes:number},bytes:Buffer)=>ref.sha256===productionHash(bytes)&&ref.bytes===bytes.length;
 const common={sourceArtifact:productionRef(source,'model/stl'),settingsArtifact:productionRef(input.settings,'application/json'),
  manifestArtifact:productionRef(input.manifest,'application/json')};
 if(rawManifest?.schema==='scan-to-make.bambu-slice/0.1.0'){
  const checkedSettings=sliceSettingsSchema.parse(settings);
  const m=mcpManifestSchema.parse(rawManifest);
  if(input.printable[0]!==0x50||input.printable[1]!==0x4b||input.printable[2]!==0x03||input.printable[3]!==0x04)
   throw new Error('Produced printable must be a sliced 3MF');
  if(!matches(m.input,source)||!matches(m.outputs.threeMf,input.printable)||!matches(m.outputs.settings,input.settings)||
   m.outputs.threeMf.file!=='source_sliced.3mf'||m.outputs.settings.file!=='settings.json')throw new Error('Producer manifest artifact identity mismatch');
  return {...common,printableMediaType:'model/3mf' as const,producerKind:'bambu-printer-mcp' as const,
   mcpServer:m.server,catalogSha256:m.catalogSha256,tool:'slice_stl' as const,slicerType:checkedSettings.slicerType};
 }
 const m=legacyManifestSchema.parse(rawManifest);
 if(!matches(m.input,source)||!matches(m.outputs.gcode,input.printable)||!matches(m.outputs.exportedSettings,input.settings)||
  m.outputs.gcode.file!=='plate_1.gcode'||m.outputs.exportedSettings.file!=='exported-settings.json')throw new Error('Producer manifest artifact identity mismatch');
 return {...common,printableMediaType:'text/x.gcode' as const,slicer:{version:m.slicer.version,binarySha256:m.slicer.binary.sha256}};
}

import {constants} from 'node:fs';
import {mkdir, mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join} from 'node:path';

export const producerBedTypeSchema = z.enum(['textured_plate', 'cool_plate', 'engineering_plate', 'hot_plate', 'supertack_plate']);
export type ProducerBedType = z.infer<typeof producerBedTypeSchema>;
export const producerNozzleTypeSchema = z.enum(['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']);
export type ProducerNozzleType = z.infer<typeof producerNozzleTypeSchema>;

export interface PreparedProducerConfiguration {
  process: TrustedMcpProcess;
  timeoutMs?: number;
}
export const preparedProducerConfigurationSchema = z.strictObject({
  process: inspectorProcessSchema,
  timeoutMs: z.number().int().min(50).max(120000).optional(),
});
const producerSelectionSchema = z.strictObject({
  printerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  model: z.string().trim().min(1).max(128),
  plateIndex: integer,
  nozzleDiameters: z.array(z.literal([0.2, 0.4, 0.6, 0.8])).min(1).max(2),
  bedType: producerBedTypeSchema,
  nozzleType: producerNozzleTypeSchema,
  materials: z.array(z.strictObject({
    projectSlot: integer, material: z.string().trim().min(1).max(128), physicalTray: integer,
  })).min(1),
});
const producerRequestSchema = z.strictObject({
  selection: producerSelectionSchema,
  allowSupports: z.boolean(),
});

async function readProductionFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('Producer file byte limit exceeded');
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const next = await file.read(buffer, length, buffer.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length !== stat.size) throw new Error('Producer file changed while reading');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await file.close(); }
}

function checkedSlicerEnvironment(env: Record<string, string> | undefined): ProducerSlicerType {
  if (!env) throw new Error('Prepared producer slicer environment is not configured');
  const slicerType = producerSlicerTypeSchema.parse(env.SLICER_TYPE);
  if (!env.SLICER_PATH || !isAbsolute(env.SLICER_PATH)) {
    throw new Error('Prepared producer SLICER_PATH must be an absolute operator-configured path');
  }
  return slicerType;
}

/**
 * Slicing through bambu-printer-mcp's `slice_stl` in a separate process,
 * using the operator's configured MCP process and environment, plus the
 * per-call private TEMP_DIR below.
 */
export function createPreparedProducer(configuration: PreparedProducerConfiguration): PreparedProducer {
  const config = preparedProducerConfigurationSchema.parse(configuration);
  const slicerType = checkedSlicerEnvironment(config.process.env);
  const identity = productionHash(JSON.stringify({adapterVersion: 3, ...config}));
  const timeoutMs = config.timeoutMs ?? 120000;
  return {identity, async produce(source, requestInput, signal) {
    if (signal?.aborted) throw new Error('Production cancelled');
    if (!Buffer.isBuffer(source) || !source.length || source.length > PRODUCTION_LIMITS.sourceBytes) {
      throw new Error('Produced source byte limit exceeded');
    }
    const request = producerRequestSchema.parse(requestInput);
    const selection = request.selection;
    if (selection.plateIndex !== 0) throw new Error('Slicing an STL produces plate 1; plateIndex must be 0');
    if (selection.nozzleDiameters.some(value => value !== selection.nozzleDiameters[0])) {
      throw new Error('slice_stl requires one nozzle diameter for all selected nozzles');
    }
    const original = Buffer.from(source);
    const nozzleDiameter = String(selection.nozzleDiameters[0]) as '0.2' | '0.4' | '0.6' | '0.8';
    const settings = Buffer.from(JSON.stringify({
      schema: 'scan-to-make.bambu-slice-settings/0.1.0',
      tool: 'slice_stl',
      slicerType,
      bambuModel: selection.model,
      nozzleDiameter,
      bedType: selection.bedType,
      nozzleType: selection.nozzleType,
      plateIndex: selection.plateIndex,
      allowSupports: request.allowSupports,
      usePrinterFilaments: false,
      orient: true,
      arrange: true,
      ensureOnBed: true,
    }) + '\n');
    const scratch = await mkdtemp(join(tmpdir(), 'prepared-production-'));
    try {
      const mcpTemp = join(scratch, 'mcp-temp');
      await mkdir(mcpTemp, {mode: 0o700});
      const input = join(scratch, 'source.stl');
      await writeFile(input, original, {flag: 'wx', mode: 0o400});
      if (signal?.aborted) throw new Error('Production cancelled');
      // TEMP_DIR is pinned to this call's private scratch so the returned
      // sliced path is containable.
      const env = {...config.process.env, TEMP_DIR: mcpTemp};
      const sliced = await slicePreparedStl(
        {...config.process, env},
        {
          stl_path: input,
          bambu_model: selection.model,
          nozzle_diameter: nozzleDiameter,
          bed_type: selection.bedType,
          nozzle_type: selection.nozzleType,
          slicer_type: slicerType,
        },
        {timeoutMs, signal},
      );
      if (signal?.aborted) throw new Error('Production cancelled');
      if (dirname(sliced.path) !== mcpTemp || basename(sliced.path) !== 'source_sliced.3mf') {
        throw new Error('Sliced output path is outside the production scratch directory');
      }
      const printable = await readProductionFile(sliced.path, 64 * 1024 * 1024);
      const catalogSha256 = productionHash(JSON.stringify(sliced.catalog));
      const manifest = Buffer.from(JSON.stringify({
        schema: 'scan-to-make.bambu-slice/0.1.0',
        tool: 'slice_stl',
        server: sliced.catalog.server,
        catalogSha256,
        input: {sha256: productionHash(original), bytes: original.length},
        outputs: {
          threeMf: {file: 'source_sliced.3mf', sha256: productionHash(printable), bytes: printable.length},
          settings: {file: 'settings.json', sha256: productionHash(settings), bytes: settings.length},
        },
      }) + '\n');
      const result = {printable, settings, manifest};
      verifyProductionBytes(original, result, 64 * 1024 * 1024);
      return result;
    } finally {
      await rm(scratch, {recursive: true, force: true});
    }
  }};
}
