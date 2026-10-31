import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, link, mkdir, mkdtemp, open, opendir, rename, rm, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readVerifiedStl} from './stl-export.js';
import {PreparedProductionSchema, PRODUCTION_LIMITS, productionHash, productionRef, verifyProductionBytes, type PreparedProducer, type PreparedProduction, type ProductionBytes} from './prepared-production.js';
import {z} from 'zod';
import {ArtifactRefSchema, type ArtifactRef} from '@scan-to-make/contracts';
import {FileSavedProjectStorage, savedProjectETag} from '@scan-to-make/project';
import {PrintSelectionSchema} from './index.js';
import {PreparedInspectionSchema, createPreparedFileInspector, printableFormat, type PreparedInspectionConfiguration} from './prepared-inspection.js';
import {createPreparedPrintabilityGate, PreparedPrintabilityFailure, PrintabilityReportSchema, type PreparedPrintabilityConfiguration, type PreparedPrintabilityGate, type PrintabilitySummary} from './prepared-printability.js';
export {PreparedPrintabilityFailure} from './prepared-printability.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const etag = z.string().regex(/^"[a-f0-9]{64}"$/);

const {slicerSettingsSha256: _settingsDigest, ...producedSelectionFields} = PrintSelectionSchema.shape;
const producedSelectionSchema = z.strictObject({
  ...producedSelectionFields,
  nozzleType: z.enum(['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']),
}).refine(selection =>
  new Set(selection.materials.map(material => material.projectSlot)).size === selection.materials.length,
  {message: 'Project filament positions must be unique'});

const preparedJobBody = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  id: z.uuid(),
  projectId,
  projectRevision: integer,
  designArtifact: ArtifactRefSchema,
  printableArtifact: ArtifactRefSchema,
  selection: PrintSelectionSchema,
  inspection: PreparedInspectionSchema.optional(),
  production: PreparedProductionSchema.optional(),
});
function hashPreparedJob(body: z.infer<typeof preparedJobBody>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export const PreparedJobSchema = preparedJobBody.extend({sha256: digest}).refine(job => {
  const {sha256, ...body} = job;
  return sha256 === hashPreparedJob(body);
}, {message: 'Prepared job content does not match its digest'});

const approvalSchema = z.strictObject({
  jobSha256: digest,
  actorId: z.string().trim().min(1),
  confirmed: z.literal(true),
  expiresAtMs: integer,
});
const intentSchema = z.strictObject({
  kind: z.literal('intent'),
  intentId: z.uuid(),
  jobId: z.uuid(),
  jobSha256: digest,
  atMs: integer,
  approval: approvalSchema,
});

export class PreparedJobFailure extends Error {
  constructor(readonly code: 'not-found' | 'job-conflict' | 'cancelled' | 'invalid-cursor' | 'cursor-stale' | 'discovery-unavailable' | 'busy' | 'not-available' | 'already-approved' | 'approval-mismatch' | 'approval-expired') {super(code);}
}

/** One producer at a time per prepared job, shared by the CLI and the listener. */
export async function withJobProduceLock<T>(directory: string, jobId: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const root = join(directory, '.produce-locks');
  await mkdir(root, {recursive: true, mode: 0o700});
  const lock = join(root, jobId.toLowerCase());
  try {
    await mkdir(lock, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PreparedJobFailure('job-conflict');
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, {recursive: true, force: true});
  }
}

const discoveryCursorFields = {version: z.literal(1), projectId, projectRevision: integer,
  etag, catalog: digest, after: z.uuid()} as const;
const discoveryCursor = z.strictObject(discoveryCursorFields);
const producedDiscoveryCursor = z.strictObject({...discoveryCursorFields, productionVersion: z.literal(1)});
const DISCOVERY = {directoryEntries: 4096, records: 200, metadataBytes: 8 * 1024 * 1024,
  pageSize: 50, summaryBytes: 1024, responseBytes: 64 * 1024, timeoutMs: 5000};

export type PreparedJob = z.infer<typeof PreparedJobSchema>;
export type PreparedJobApproval = z.infer<typeof approvalSchema>;

const printabilitySummarySchema = PrintabilityReportSchema.pick({verdict:true, reasonCodes:true, reasons:true, warnings:true, profile:true});
const productionOperationSchema = z.strictObject({
  schema: z.literal('scan-to-make.prepared-production-operation/0.1'),
  jobId: z.uuid(), projectId, projectRevision: integer,
  requestSha256: digest, sourceArtifact: ArtifactRefSchema, allowSupports: z.boolean(),
  status: z.enum(['running', 'succeeded', 'failed']),
  failure: z.strictObject({code: z.string().min(1).max(64), printability: printabilitySummarySchema.optional()}).optional(),
  createdAtMs: integer, finishedAtMs: integer.optional(),
});
type ProductionOperation = z.infer<typeof productionOperationSchema>;
const attemptLinkSchema = z.strictObject({
  attemptId: z.uuid(), printerId: projectId, planSha256: digest,
  outcome: z.enum(['started', 'unconfirmed', 'uncertain']).optional(),
  resolution: z.enum(['finished', 'cancelled', 'rejected']).optional(),
});
export type PreparedAttemptLink = z.infer<typeof attemptLinkSchema>;
export interface PreparedProductionView {
  jobId: string;
  status: 'running' | 'succeeded' | 'failed';
  failure?: {code: string; printability?: PrintabilitySummary};
  job?: {jobId: string; jobSha256: string; printableArtifact: ArtifactRef; selection: PreparedJob['selection']};
  printability?: PrintabilitySummary;
  gcodeSummary?: Record<string, unknown>;
  profile: {displayName: string; nozzleDiameterMm: number; nozzleType?: string; bedType: string};
}
// Productions running in this process, across store instances on one directory.
const activeProductions = new Map<string, {controller: AbortController; done?: Promise<void>}>();
export type PreparedJobIntent = z.infer<typeof intentSchema>;
export interface PreparedJobLimits {maxPrintableBytes?: number; maxMetadataBytes?: number}
export const DEFAULT_PREPARED_JOB_LIMITS = {maxPrintableBytes: 64 * 1024 * 1024, maxMetadataBytes: 1024 * 1024};

function limits(input: PreparedJobLimits) {
  const result = {...DEFAULT_PREPARED_JOB_LIMITS, ...input};
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_PREPARED_JOB_LIMITS[key as keyof typeof result]) {
      throw new Error('Invalid prepared job byte limit');
    }
  }
  return result;
}
function refOf(bytes: Buffer, mediaType: string): ArtifactRef {
  return {sha256: createHash('sha256').update(bytes).digest('hex'), mediaType, byteLength: bytes.length};
}
function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mediaType === b.mediaType;
}
async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try { await file.sync(); } finally { await file.close(); }
}
async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Prepared job artifact must be a regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Prepared job artifact exceeds byte limit');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/** Approval-bound print preparation over portable saved projects.
 * Records one dispatch intent per prepared job; optionally inspects retained
 * bytes through a trusted file-only worker, but never dispatches or observes hardware. Intent is durable evidence of a human
 * approval for these exact bytes, not permission to execute: a future
 * executor must still inspect and re-verify through its own gate.
 */
export class PreparedJobStore {
  private readonly bound: ReturnType<typeof limits>;
  private readonly clock: () => number;
  private readonly production?: PreparedProducer;
  private readonly inspect?: ReturnType<typeof createPreparedFileInspector>;
  private readonly printability?: PreparedPrintabilityGate;
  private readonly appProduction?: {selection: z.infer<typeof producedSelectionSchema>; displayName: string};
  constructor(private readonly projects: FileSavedProjectStorage, private readonly directory: string,
    options: PreparedJobLimits & {clock?: () => number; inspection?: PreparedInspectionConfiguration; production?: PreparedProducer; printability?: PreparedPrintabilityConfiguration; appProduction?: {selection: unknown; displayName: string}} = {}) {
    const {clock, inspection: inspectionOptions, production, printability, appProduction, ...byteLimits} = options;
    if (appProduction) {
      this.appProduction = {selection: producedSelectionSchema.parse(appProduction.selection),
        displayName: z.string().trim().min(1).max(256).parse(appProduction.displayName)};
    }
    if(production){digest.parse(production.identity);this.production={identity:production.identity,produce:production.produce.bind(production)};}
    this.inspect = inspectionOptions ? createPreparedFileInspector(inspectionOptions) : undefined;
    this.printability = printability ? createPreparedPrintabilityGate(printability) : undefined;
    this.bound = limits(byteLimits);
    this.clock = clock ?? Date.now;
  }

  get inspectionEnabled(): boolean { return this.inspect !== undefined; }
  get maxPrintableBytes(): number { return this.bound.maxPrintableBytes; }
  get appProductionEnabled(): boolean { return this.appProduction !== undefined && this.production !== undefined && this.inspect !== undefined; }

  /** Abort and await any app-started production running for this directory. */
  async close(): Promise<void> {
    for (const [key, active] of activeProductions) {
      if (!key.startsWith(`${this.directory}\0`)) continue;
      active.controller.abort();
      await active.done;
    }
  }

  private producedRequestSha256(request: {projectId: string; projectRevision: number; expectedProjectETag: string; jobId: string; selection: unknown},
      allowSupports: boolean, sourceArtifact: ReturnType<typeof productionRef>): string {
    const ref = {sha256: sourceArtifact.sha256, byteLength: sourceArtifact.byteLength, mediaType: sourceArtifact.mediaType};
    return productionHash(JSON.stringify({projectId: request.projectId, projectRevision: request.projectRevision,
      expectedProjectETag: request.expectedProjectETag, jobId: request.jobId, selection: request.selection,
      allowSupports, sourceArtifact: ref, producerIdentity: this.production!.identity,
      printabilityIdentity: this.printability?.identity}));
  }
  private operationRequestSha256(operation: {projectId: string; projectRevision: number; jobId: string;
      sourceArtifact: ProductionOperation['sourceArtifact']; allowSupports: boolean}, selection: unknown): string {
    const ref = {sha256: operation.sourceArtifact.sha256, byteLength: operation.sourceArtifact.byteLength, mediaType: operation.sourceArtifact.mediaType};
    return productionHash(JSON.stringify({projectId: operation.projectId, projectRevision: operation.projectRevision,
      jobId: operation.jobId, sourceArtifact: ref, allowSupports: operation.allowSupports,
      selection, producerIdentity: this.production!.identity, printabilityIdentity: this.printability?.identity}));
  }

  /** Host-only production. Long slicing happens outside the project edit lock. */
  async prepareProduced(input:{projectId:string;projectRevision:number;expectedProjectETag:string;jobId:string;source:Uint8Array;selection:unknown;allowSupports?:boolean},
    signal?:AbortSignal,authorizeCommit?:()=>Promise<void>){
    const active=()=>{if(signal?.aborted)throw new PreparedJobFailure('cancelled');};active();
    if(!this.production||!this.inspect)throw new Error('Trusted production and inspection must be configured');
    const producer=this.production;
    const allowSupports=input.allowSupports===undefined?false:z.boolean().parse(input.allowSupports);
    const request=z.strictObject({projectId,projectRevision:integer,expectedProjectETag:etag,jobId:z.uuid().transform(value => value.toLowerCase()),
      selection:producedSelectionSchema}).parse({projectId:input.projectId,projectRevision:input.projectRevision,
      expectedProjectETag:input.expectedProjectETag,jobId:input.jobId,selection:input.selection});
    if(!(input.source instanceof Uint8Array)||!input.source.length||input.source.length>PRODUCTION_LIMITS.sourceBytes)throw new Error('Produced source byte limit exceeded');
    const source=Buffer.from(input.source),sourceArtifact=productionRef(source,'model/stl');
    const requestSha256=this.producedRequestSha256(request,allowSupports,sourceArtifact);
    await this.projects.withCurrentProject(request.projectId,request.projectRevision,async project=>{
      if(!project.acceptedArtifact||!sameRef(project.acceptedArtifact.artifact,sourceArtifact))throw new Error('Produced source does not match accepted artifact');
    },request.expectedProjectETag);active();
    let existing:PreparedJob|undefined;
    try{existing=await this.readJob(request.jobId.toLowerCase());}catch(error){if(!(error instanceof PreparedJobFailure)||error.code!=='not-found')throw error;}
    if(existing){
      if(existing.production?.requestSha256!==requestSha256)throw new PreparedJobFailure('job-conflict');
      const loaded=await this.loadPreparedJob(existing.id,request.expectedProjectETag);await authorizeCommit?.();active();
      return {jobId:existing.id,job:loaded.job,created:false};
    }
    const temp=await mkdtemp(join(tmpdir(),'prepared-source-'));
    try{
      const path=join(temp,'source.stl');await writeSynced(path,source);await chmod(path,0o400);await readVerifiedStl(path,sourceArtifact);active();
      // Printability gate: after source verification, before any slicing.
      const gated=this.printability?await this.printability.check(path,sourceArtifact,request.selection,allowSupports,signal):undefined;active();
      const result=await producer.produce(Buffer.from(source),{selection:request.selection,allowSupports},signal);active();
      for(const [bytes,max] of [[result.printable,this.bound.maxPrintableBytes],[result.settings,PRODUCTION_LIMITS.settingsBytes],[result.manifest,PRODUCTION_LIMITS.manifestBytes]] as const){
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max)throw new Error('Produced output byte limit exceeded');
      }
      const produced={printable:Buffer.from(result.printable),settings:Buffer.from(result.settings),manifest:Buffer.from(result.manifest)};
      const {printableMediaType,...verifiedProduction}=verifyProductionBytes(source,produced,this.bound.maxPrintableBytes);
      const production=PreparedProductionSchema.parse({...verifiedProduction,requestSha256,producerIdentity:producer.identity,
        ...(gated?{printability:{profileId:gated.report.profile.id,verdict:gated.report.verdict,allowSupports,reportArtifact:productionRef(gated.reportBytes,'application/json')}}:{})});
      return await this.prepareInternal({...request,printable:produced.printable,printableArtifact:productionRef(produced.printable,printableMediaType),
        selection:{...request.selection,slicerSettingsSha256:production.settingsArtifact.sha256}},signal,authorizeCommit,{metadata:production,source,...produced,...(gated?{printabilityReport:gated.reportBytes}:{})});
    }finally{await rm(temp,{recursive:true,force:true});}
  }

  private operationPath(jobId: string): string { return join(this.directory, '.production-operations', `${jobId}.json`); }
  // Lock-free current-snapshot check for status reads: a running production
  // holds the project lock across inspection, and polls must not fail on it.
  private async assertCurrentSnapshot(request: {projectId: string; expectedProjectETag: string}): Promise<void> {
    const snapshot = await this.projects.read(request.projectId);
    if (snapshot === null) throw new PreparedJobFailure('not-found');
    if (savedProjectETag(snapshot) !== request.expectedProjectETag) throw new Error('Saved project ETag mismatch');
  }
  // A crash can strand a running record after the job itself was published.
  // Finish it only when the fully verified job matches both retained hashes.
  private async reconcilePublishedOperation(operation: ProductionOperation): Promise<ProductionOperation | undefined> {
    if (!this.production) return undefined;
    const snapshot = await this.projects.read(operation.projectId).catch(() => null);
    if (snapshot === null) return undefined;
    const expectedProjectETag = savedProjectETag(snapshot);
    let job: PreparedJob;
    try { job = (await this.loadPreparedJob(operation.jobId, expectedProjectETag)).job; }
    catch { return undefined; }
    if (job.projectId !== operation.projectId || job.projectRevision !== operation.projectRevision || !job.production) return undefined;
    if (!sameRef(job.designArtifact, operation.sourceArtifact) || !sameRef(job.production.sourceArtifact, operation.sourceArtifact)) return undefined;
    if (job.production.producerIdentity !== this.production.identity) return undefined;
    const {slicerSettingsSha256: _settingsDigest, ...selection} = job.selection;
    if (this.operationRequestSha256(operation, selection) !== operation.requestSha256) return undefined;
    const producedSha = this.producedRequestSha256(
      {projectId: operation.projectId, projectRevision: operation.projectRevision, expectedProjectETag, jobId: operation.jobId, selection},
      operation.allowSupports, operation.sourceArtifact);
    if (producedSha !== job.production.requestSha256) return undefined;
    if (this.printability && (!job.production.printability || job.production.printability.allowSupports !== operation.allowSupports)) return undefined;
    return {...operation, status: 'succeeded', failure: undefined, finishedAtMs: integer.parse(this.clock())};
  }
  private async readOperation(jobId: string): Promise<ProductionOperation | undefined> {
    let bytes: Buffer;
    try { bytes = await readBounded(this.operationPath(jobId), this.bound.maxMetadataBytes); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const operation = productionOperationSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    if (operation.jobId !== jobId) throw new Error('Stored production operation identity mismatch');
    // A running record with no live owner may already have published its job.
    if (operation.status === 'running' && !activeProductions.has(`${this.directory}\0${jobId}`)) {
      const reconciled = await this.reconcilePublishedOperation(operation);
      if (reconciled) {
        await this.writeOperation(reconciled).catch(() => undefined);
        return reconciled;
      }
      const interrupted: ProductionOperation = {...operation, status: 'failed', failure: {code: 'interrupted'}, finishedAtMs: integer.parse(this.clock())};
      await this.writeOperation(interrupted);
      return interrupted;
    }
    return operation;
  }
  private async writeOperation(operation: ProductionOperation): Promise<void> {
    await mkdir(join(this.directory, '.production-operations'), {recursive: true, mode: 0o700});
    const finalPath = this.operationPath(operation.jobId);
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    await writeSynced(temporary, Buffer.from(JSON.stringify(operation) + '\n'));
    try { await rename(temporary, finalPath); } finally { await unlink(temporary).catch(() => undefined); }
    await syncDirectory(join(this.directory, '.production-operations'));
  }
  private profileView(selection: {model: string; bedType: string; nozzleDiameters: readonly number[]; nozzleType?: string}): PreparedProductionView['profile'] {
    return {displayName: this.appProduction?.displayName ?? selection.model,
      nozzleDiameterMm: selection.nozzleDiameters[0]!, bedType: selection.bedType,
      ...(selection.nozzleType ? {nozzleType: selection.nozzleType} : {})};
  }
  private async productionView(request: {projectId: string; projectRevision: number}, operation: ProductionOperation | undefined, job: PreparedJob | undefined): Promise<PreparedProductionView> {
    const selection = job?.selection ?? this.appProduction?.selection;
    if (!selection) throw new PreparedJobFailure('not-available');
    const view: PreparedProductionView = {jobId: operation?.jobId ?? job!.id,
      status: operation ? operation.status : 'succeeded', profile: this.profileView(selection)};
    if (operation?.failure) view.failure = operation.failure;
    if (job) {
      view.job = {jobId: job.id, jobSha256: job.sha256, printableArtifact: job.printableArtifact, selection: job.selection};
      if (job.production?.printability) {
        const report = await readBounded(join(this.directory, job.id, 'printability.json'), 1024 * 1024);
        const parsed = PrintabilityReportSchema.parse(JSON.parse(report.toString('utf8')));
        view.printability = {verdict: parsed.verdict, reasonCodes: parsed.reasonCodes, reasons: parsed.reasons, warnings: parsed.warnings, profile: parsed.profile};
      }
      if (job.production) {
        try {
          const manifest = JSON.parse((await readBounded(join(this.directory, job.id, 'production.json'), PRODUCTION_LIMITS.manifestBytes)).toString('utf8'));
          const summary = manifest?.outputs?.gcodeSummary;
          if (summary && typeof summary === 'object' && !Array.isArray(summary)) view.gcodeSummary = summary;
        } catch { /* summary is best-effort display data; verified bytes were already checked */ }
      }
    }
    void request;
    return view;
  }

  /**
   * App-facing asynchronous production over the operator-pinned profile.
   * Start is never replayed automatically: the same job id with the same
   * request returns the retained operation, any other request conflicts.
   */
  async startPreparedProduction(input: {projectId: string; projectRevision: number; expectedProjectETag: string;
      jobId: string; source: Uint8Array; allowSupports?: boolean},
      authorizeCommit?: () => Promise<void>): Promise<{view: PreparedProductionView; created: boolean}> {
    if (!this.appProductionEnabled || !this.appProduction) throw new PreparedJobFailure('not-available');
    const allowSupports = input.allowSupports === undefined ? false : z.boolean().parse(input.allowSupports);
    const request = z.strictObject({projectId, projectRevision: integer, expectedProjectETag: etag,
      jobId: z.uuid().transform(value => value.toLowerCase())}).parse({projectId: input.projectId,
      projectRevision: input.projectRevision, expectedProjectETag: input.expectedProjectETag, jobId: input.jobId});
    if (!(input.source instanceof Uint8Array) || !input.source.length || input.source.length > PRODUCTION_LIMITS.sourceBytes) throw new Error('Produced source byte limit exceeded');
    const source = Buffer.from(input.source), sourceArtifact = productionRef(source, 'model/stl');
    const key = `${this.directory}\0${request.jobId}`;
    const requestSha256 = this.operationRequestSha256({projectId: request.projectId, projectRevision: request.projectRevision,
      jobId: request.jobId, sourceArtifact, allowSupports}, this.appProduction.selection);
    await this.projects.withCurrentProject(request.projectId, request.projectRevision, async project => {
      if (!project.acceptedArtifact || !sameRef(project.acceptedArtifact.artifact, sourceArtifact)) throw new Error('Produced source does not match accepted artifact');
    }, request.expectedProjectETag);
    const existingOperation = await this.readOperation(request.jobId);
    if (existingOperation) {
      if (existingOperation.requestSha256 !== requestSha256) throw new PreparedJobFailure('job-conflict');
      const job = existingOperation.status === 'succeeded' ? (await this.loadPreparedJob(request.jobId, request.expectedProjectETag)).job : undefined;
      return {view: await this.productionView(request, existingOperation, job), created: false};
    }
    let existingJob: PreparedJob | undefined;
    try { existingJob = await this.readJob(request.jobId); }
    catch (error) { if (!(error instanceof PreparedJobFailure) || error.code !== 'not-found') throw error; }
    if (existingJob) {
      const producedSha = this.producedRequestSha256(
        {projectId: request.projectId, projectRevision: request.projectRevision, expectedProjectETag: request.expectedProjectETag,
          jobId: request.jobId, selection: this.appProduction.selection}, allowSupports, sourceArtifact);
      if (!existingJob.production || existingJob.projectId !== request.projectId || existingJob.projectRevision !== request.projectRevision ||
          !sameRef(existingJob.designArtifact, sourceArtifact) || !sameRef(existingJob.production.sourceArtifact, sourceArtifact) ||
          existingJob.production.requestSha256 !== producedSha ||
          existingJob.production.producerIdentity !== this.production!.identity) throw new PreparedJobFailure('job-conflict');
      const loaded = await this.loadPreparedJob(request.jobId, request.expectedProjectETag);
      return {view: await this.productionView(request, undefined, loaded.job), created: false};
    }
    if ([...activeProductions.keys()].some(activeKey => activeKey.startsWith(`${this.directory}\0`))) throw new PreparedJobFailure('busy');
    const controller = new AbortController();
    const entry: {controller: AbortController; done?: Promise<void>} = {controller};
    activeProductions.set(key, entry);
    const operation: ProductionOperation = {schema: 'scan-to-make.prepared-production-operation/0.1', jobId: request.jobId,
      projectId: request.projectId, projectRevision: request.projectRevision, requestSha256, sourceArtifact,
      allowSupports, status: 'running', createdAtMs: integer.parse(this.clock())};
    try {
      await mkdir(join(this.directory, '.production-operations'), {recursive: true, mode: 0o700});
      const finalPath = this.operationPath(request.jobId), temporary = `${finalPath}.${randomUUID()}.tmp`;
      await writeSynced(temporary, Buffer.from(JSON.stringify(operation) + '\n'));
      try { await link(temporary, finalPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PreparedJobFailure('job-conflict');
        throw error;
      } finally { await unlink(temporary).catch(() => undefined); }
      await syncDirectory(join(this.directory, '.production-operations'));
    } catch (error) { activeProductions.delete(key); throw error; }
    const selection = structuredClone(this.appProduction.selection);
    const done = (async () => {
      let finished: ProductionOperation;
      try {
        await withJobProduceLock(this.directory, request.jobId, async () => {
          await this.prepareProduced({...request, source, selection, allowSupports}, controller.signal, authorizeCommit);
        });
        finished = {...operation, status: 'succeeded', finishedAtMs: integer.parse(this.clock())};
      } catch (error) {
        const failure = error instanceof PreparedPrintabilityFailure
          ? {code: error.code, ...(error.summary ? {printability: error.summary} : {})}
          : error instanceof PreparedJobFailure ? {code: error.code} : {code: 'production-failed'};
        finished = {...operation, status: 'failed', failure, finishedAtMs: integer.parse(this.clock())};
      }
      await this.writeOperation(finished).catch(() => undefined);
    })().finally(() => { activeProductions.delete(key); });
    entry.done = done;
    void done.catch(() => undefined);
    return {view: await this.productionView(request, operation, undefined), created: true};
  }

  async loadPreparedProduction(input: {projectId: string; projectRevision: number; expectedProjectETag: string; jobId: string}): Promise<{view: PreparedProductionView}> {
    const request = z.strictObject({projectId, projectRevision: integer, expectedProjectETag: etag,
      jobId: z.uuid().transform(value => value.toLowerCase())}).parse(input);
    const operation = await this.readOperation(request.jobId);
    if (operation && (operation.projectId !== request.projectId || operation.projectRevision !== request.projectRevision)) throw new PreparedJobFailure('not-found');
    // A running or failed operation answers from its own record; the job
    // directory may be mid-publication and must not be verified yet.
    if (operation && operation.status !== 'succeeded') {
      await this.assertCurrentSnapshot(request);
      return {view: await this.productionView(request, operation, undefined)};
    }
    let job: PreparedJob | undefined;
    try { job = await this.readJob(request.jobId); }
    catch (error) { if (!(error instanceof PreparedJobFailure) || error.code !== 'not-found') throw error; }
    if (job && (job.projectId !== request.projectId || job.projectRevision !== request.projectRevision)) throw new PreparedJobFailure('not-found');
    if (!operation && !job) throw new PreparedJobFailure('not-found');
    if (job) {
      const loaded = await this.loadPreparedJob(request.jobId, request.expectedProjectETag);
      return {view: await this.productionView(request, operation, loaded.job)};
    }
    await this.assertCurrentSnapshot(request);
    return {view: await this.productionView(request, operation, undefined)};
  }

  /** Prepared intent plus the host executor's optional journal link projection. */
  async loadAttemptStatus(input: {projectId: string; projectRevision: number; expectedProjectETag: string; jobId: string}) {
    const request = z.strictObject({projectId, projectRevision: integer, expectedProjectETag: etag,
      jobId: z.uuid().transform(value => value.toLowerCase())}).parse(input);
    const loaded = await this.loadPreparedJob(request.jobId, request.expectedProjectETag);
    if (loaded.job.projectId !== request.projectId || loaded.job.projectRevision !== request.projectRevision) throw new PreparedJobFailure('not-found');
    let linkedAttempt: PreparedAttemptLink | null = null;
    try {
      const bytes = await readBounded(join(this.directory, loaded.job.id, 'attempt-link.json'), this.bound.maxMetadataBytes);
      linkedAttempt = attemptLinkSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {jobId: loaded.job.id,
      intent: loaded.intent ? {intentId: loaded.intent.intentId, atMs: loaded.intent.atMs} : null,
      linkedAttempt};
  }

  async prepare(input: {projectId: string; projectRevision: number; printable: Uint8Array;
      printableArtifact: unknown; selection: unknown; expectedProjectETag?: string; jobId?: string},
      signal?: AbortSignal, authorizeCommit?: () => Promise<void>):
      Promise<{jobId: string; job: PreparedJob; created: boolean}> {
    return this.prepareInternal(input,signal,authorizeCommit);
  }

  private async prepareInternal(input: {projectId: string; projectRevision: number; printable: Uint8Array;
      printableArtifact: unknown; selection: unknown; expectedProjectETag?: string; jobId?: string},
      signal?: AbortSignal, authorizeCommit?: () => Promise<void>, produced?: ProductionBytes & {source:Buffer;metadata:PreparedProduction;printabilityReport?:Buffer}):
      Promise<{jobId: string; job: PreparedJob; created: boolean}> {
    const assertActive = () => { if (signal?.aborted) throw new PreparedJobFailure('cancelled'); };
    assertActive();
    const jobId = input.jobId === undefined ? randomUUID() : z.uuid().parse(input.jobId).toLowerCase();
    const request = z.strictObject({
      projectId, projectRevision: integer, printableArtifact: ArtifactRefSchema, selection: PrintSelectionSchema,
    }).parse({projectId: input.projectId, projectRevision: input.projectRevision,
      printableArtifact: input.printableArtifact, selection: input.selection});
    const expectedProjectETag = input.expectedProjectETag === undefined ? undefined : etag.parse(input.expectedProjectETag);
    if (!(input.printable instanceof Uint8Array) || !input.printable.byteLength ||
        input.printable.byteLength > this.bound.maxPrintableBytes) throw new Error('Printable byte limit exceeded');
    const bytes = Buffer.from(input.printable); // Snapshot before any asynchronous operation.
    if (!sameRef(refOf(bytes, request.printableArtifact.mediaType), request.printableArtifact)) {
      throw new Error('Printable artifact identity mismatch');
    }
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const staging = await mkdtemp(join(this.directory, '.staging-'));
    try {
      await writeSynced(join(staging, 'printable.bin'), bytes);
      await chmod(join(staging, 'printable.bin'), 0o400);
      return await this.projects.withCurrentProject(request.projectId, request.projectRevision, async project => {
        if (project.id !== request.projectId) throw new Error('Project identity mismatch');
        if (!project.acceptedArtifact) throw new Error('Current design must be accepted before preparing a print job');
        assertActive();
        let existing: PreparedJob | undefined;
        try { existing = await this.readJob(jobId); }
        catch (error) { if (!(error instanceof PreparedJobFailure) || error.code !== 'not-found') throw error; }
        if (existing) {
          if (JSON.stringify(existing.production)!==JSON.stringify(produced?.metadata)||existing.projectId !== request.projectId || existing.projectRevision !== request.projectRevision ||
              !sameRef(existing.designArtifact, project.acceptedArtifact.artifact) ||
              !sameRef(existing.printableArtifact, request.printableArtifact) ||
              JSON.stringify(existing.selection) !== JSON.stringify(request.selection)) throw new PreparedJobFailure('job-conflict');
          await this.verifiedPrintable(existing);
          // Never promote an older uninspected job or rerun a changed inspector on retry.
          if (this.inspect && !existing.inspection) throw new PreparedJobFailure('job-conflict');
          await authorizeCommit?.(); assertActive();
          return {jobId, job: existing, created: false};
        }
        let inspection;
        if (this.inspect) {
          const file = join(staging, `inspection.${printableFormat(request.printableArtifact)}`);
          await writeSynced(file, bytes);
          await chmod(file, 0o400);
          try { inspection = await this.inspect(file, request.printableArtifact, request.selection, signal); }
          finally { await rm(file, {force: true}); }
          // A worker never supplies retained bytes. Recheck the private original before publication.
          const retained = await readBounded(join(staging, 'printable.bin'), this.bound.maxPrintableBytes);
          if (!sameRef(refOf(retained, request.printableArtifact.mediaType), request.printableArtifact)) {
            throw new Error('Printable bytes changed during inspection');
          }
        }
        const body = preparedJobBody.parse({
          formatVersion: '0.1.0', id: jobId, projectId: request.projectId, projectRevision: project.revision,
          designArtifact: project.acceptedArtifact.artifact, printableArtifact: request.printableArtifact,
          selection: request.selection, ...(inspection ? {inspection} : {}), ...(produced?{production:produced.metadata}:{}),
        });
        const job = PreparedJobSchema.parse({...body, sha256: hashPreparedJob(body)});
        if(produced){
          if(!sameRef(produced.metadata.sourceArtifact,project.acceptedArtifact.artifact))throw new Error('Produced accepted source changed');
          for(const [name,bytes] of [['source.stl',produced.source],['settings.json',produced.settings],['production.json',produced.manifest]] as const){
            await writeSynced(join(staging,name),bytes);await chmod(join(staging,name),0o400);
          }
          if(produced.printabilityReport){await writeSynced(join(staging,'printability.json'),produced.printabilityReport);await chmod(join(staging,'printability.json'),0o400);}
        }
        const jobBytes = Buffer.from(JSON.stringify(job) + '\n');
        if (jobBytes.length > this.bound.maxMetadataBytes) throw new Error('Prepared job metadata byte limit exceeded');
        await writeSynced(join(staging, 'job.json'), jobBytes);
        await syncDirectory(staging);
        // Re-authorize after all asynchronous writes, immediately before publication.
        assertActive(); await authorizeCommit?.(); assertActive();
        // Atomic publication is the commit point, serialized with project edits.
        try { await rename(staging, join(this.directory, jobId)); }
        catch (error) {
          if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new PreparedJobFailure('job-conflict');
          throw error;
        }
        await syncDirectory(this.directory);
        return {jobId, job, created: true};
      }, expectedProjectETag);
    } finally { await rm(staging, {recursive: true, force: true}); }
  }

  /** Metadata handles only. No printable or intent file is opened here.
   * Cursor pins the observed directory-name set; additions/removals require refresh.
   */
  async listPreparedJobs(input: {projectId: string; projectRevision: number; expectedProjectETag: string;
      limit?: number; cursor?: string; productionVersion?: 1}, signal?: AbortSignal) {
    const request = z.strictObject({projectId, projectRevision: integer, expectedProjectETag: etag,
      limit: z.number().int().min(1).max(DISCOVERY.pageSize).default(20), cursor: z.string().max(1024).optional(),
      productionVersion: z.literal(1).optional()}).parse(input);
    const deadline = AbortSignal.timeout(DISCOVERY.timeoutMs);
    const assertActive = () => {
      if (signal?.aborted) throw new PreparedJobFailure('cancelled');
      if (deadline.aborted) throw new PreparedJobFailure('discovery-unavailable');
    };
    let cursor: z.infer<typeof discoveryCursor> | undefined;
    if (request.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new Error();
        const bytes = Buffer.from(request.cursor, 'base64url');
        if (bytes.toString('base64url') !== request.cursor) throw new Error();
        cursor = (request.productionVersion === 1 ? producedDiscoveryCursor : discoveryCursor)
          .parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
        if (cursor.projectId !== request.projectId || cursor.projectRevision !== request.projectRevision ||
            cursor.etag !== request.expectedProjectETag || cursor.after !== cursor.after.toLowerCase()) throw new Error();
      } catch { throw new PreparedJobFailure('invalid-cursor'); }
    }
    return this.projects.withCurrentProject(request.projectId, request.projectRevision, async project => {
      assertActive();
      if (!project.acceptedArtifact) throw new Error('Current design must be accepted before discovering prepared jobs');
      const entries: {id: string; directory: boolean}[] = [];
      try {
        const directory = await opendir(this.directory, {bufferSize: 32});
        let count = 0;
        for await (const entry of directory) {
          assertActive();
          if (++count > DISCOVERY.directoryEntries) throw new PreparedJobFailure('discovery-unavailable');
          if (entry.name === entry.name.toLowerCase() && z.uuid().safeParse(entry.name).success) {
            entries.push({id: entry.name, directory: entry.isDirectory()});
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof PreparedJobFailure) throw error;
          throw new PreparedJobFailure('discovery-unavailable');
        }
      }
      entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const catalog = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      if (cursor && cursor.catalog !== catalog) throw new PreparedJobFailure('cursor-stale');
      let position = cursor ? entries.findIndex(entry => entry.id === cursor.after) + 1 : 0;
      if (cursor && position === 0) throw new PreparedJobFailure('invalid-cursor');
      const jobs: {jobId: string; jobSha256: string; printableArtifact: ArtifactRef; model: string; plateIndex: number}[] = [];
      let unreadable = 0, scanned = 0, budget = DISCOVERY.metadataBytes;
      while (position < entries.length && scanned < DISCOVERY.records && jobs.length < request.limit && budget > this.bound.maxMetadataBytes) {
        assertActive();
        const entry = entries[position++]!; scanned++;
        if (!entry.directory) {unreadable++; continue;}
        let bytes: Buffer | undefined;
        let job: PreparedJob;
        try {
          bytes = await readBounded(join(this.directory, entry.id, 'job.json'), this.bound.maxMetadataBytes);
          job = this.parseJob(entry.id, bytes);
        } catch {
          unreadable++;
          // A rejected oversized read may consume the one-byte overflow probe.
          budget -= bytes?.length ?? this.bound.maxMetadataBytes + 1;
          continue;
        }
        budget -= bytes.length;
        if (job.projectId !== request.projectId || job.projectRevision !== request.projectRevision ||
            !sameRef(job.designArtifact, project.acceptedArtifact.artifact) || !job.inspection ||
            (job.production && request.productionVersion !== 1)) continue;
        const summary = {jobId: job.id, jobSha256: job.sha256, printableArtifact: job.printableArtifact,
          model: job.selection.model, plateIndex: job.selection.plateIndex};
        if (Buffer.byteLength(JSON.stringify(summary)) > DISCOVERY.summaryBytes) {unreadable++; continue;}
        jobs.push(summary);
      }
      assertActive();
      const nextCursor = position < entries.length ? Buffer.from(JSON.stringify({version: 1,
        projectId: request.projectId, projectRevision: request.projectRevision, etag: request.expectedProjectETag,
        catalog, after: entries[position - 1]!.id,
        ...(request.productionVersion === 1 ? {productionVersion: 1} : {})})).toString('base64url') : null;
      const result = {jobs, nextCursor, unreadable, requiresVerifiedGet: true as const};
      if (Buffer.byteLength(JSON.stringify(result)) > DISCOVERY.responseBytes) throw new PreparedJobFailure('discovery-unavailable');
      return result;
    }, request.expectedProjectETag);
  }

  async loadPreparedJob(jobId: string, expectedProjectETag?: string) {
    const job = await this.readJob(z.uuid().parse(jobId).toLowerCase());
    const etagValue = expectedProjectETag === undefined ? undefined : etag.parse(expectedProjectETag);
    return this.projects.withCurrentProject(job.projectId, job.projectRevision, async project => {
      const printable = await this.verifiedPrintable(job);
      this.requireCurrentDesign(project, job);
      const intent = await this.readIntent(job);
      return {jobId: job.id, job, printable, intent, project};
    }, etagValue);
  }

  /** Records the single intent for a job. A second claim, including an exact
   * replay after restart, always rejects. This never starts a print.
   */
  async claimIntent(jobId: string, approvalInput: unknown): Promise<PreparedJobIntent> {
    const job = await this.readJob(z.uuid().parse(jobId).toLowerCase());
    const approval = approvalSchema.parse(approvalInput);
    return this.projects.withCurrentProject(job.projectId, job.projectRevision, async project => {
      const now = integer.parse(this.clock());
      this.requireFreshApproval(job, approval, now);
      await this.verifiedPrintable(job);
      this.requireCurrentDesign(project, job);
      const checkedNow = integer.parse(this.clock());
      this.requireFreshApproval(job, approval, checkedNow);
      const intent = intentSchema.parse({kind: 'intent', intentId: randomUUID(), jobId: job.id,
        jobSha256: job.sha256, atMs: checkedNow, approval});
      const intentBytes = Buffer.from(JSON.stringify(intent) + '\n');
      if (intentBytes.length > this.bound.maxMetadataBytes) throw new Error('Prepared job intent metadata byte limit exceeded');
      const folder = join(this.directory, job.id);
      const temporary = join(folder, `intent.${randomUUID()}.tmp`);
      await writeSynced(temporary, intentBytes);
      try {
        // The write above can outlast the approval window; freshness must still
        // hold at publication, or nothing is published.
        this.requireFreshApproval(job, approval, integer.parse(this.clock()));
        // link() is the once-only commit: it fails if the intent already exists,
        // and the visible intent is never a partial write.
        await link(temporary, join(folder, 'intent.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('This prepared job already has an intent; never replay it');
        }
        throw error;
      } finally { await unlink(temporary).catch(() => undefined); }
      await syncDirectory(folder);
      return intent;
    });
  }

  private requireFreshApproval(job: PreparedJob, approval: PreparedJobApproval, now: number): void {
    if (approval.jobSha256 !== job.sha256 || approval.expiresAtMs <= now || approval.expiresAtMs > now + 300000) {
      throw new Error('Approval must match this prepared job and expire within five minutes');
    }
  }
  private requireCurrentDesign(project: {acceptedArtifact: {artifact: ArtifactRef} | null}, job: PreparedJob): void {
    if (!project.acceptedArtifact || !sameRef(project.acceptedArtifact.artifact, job.designArtifact)) {
      throw new Error('Accepted design changed after print preparation');
    }
  }
  private async readJob(jobId: string): Promise<PreparedJob> {
    let bytes: Buffer;
    try { bytes = await readBounded(join(this.directory, jobId, 'job.json'), this.bound.maxMetadataBytes); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PreparedJobFailure('not-found'); throw error; }
    return this.parseJob(jobId, bytes);
  }
  private parseJob(jobId: string, bytes: Buffer): PreparedJob {
    const job = PreparedJobSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    if (job.id !== jobId) throw new Error('Stored prepared job identity mismatch');
    return job;
  }
  private async verifiedPrintable(job: PreparedJob): Promise<Buffer> {
    const bytes = await readBounded(join(this.directory, job.id, 'printable.bin'), this.bound.maxPrintableBytes);
    if (!sameRef(refOf(bytes, job.printableArtifact.mediaType), job.printableArtifact)) {
      throw new Error('Printable artifact digest or byte length mismatch');
    }
    if(job.production){
      const folder=join(this.directory,job.id);
      const source=await readBounded(join(folder,'source.stl'),PRODUCTION_LIMITS.sourceBytes);
      const settings=await readBounded(join(folder,'settings.json'),PRODUCTION_LIMITS.settingsBytes);
      const manifest=await readBounded(join(folder,'production.json'),PRODUCTION_LIMITS.manifestBytes);
      const checked=verifyProductionBytes(source,{printable:bytes,settings,manifest},this.bound.maxPrintableBytes);
      const evidenceMatches=checked.printableMediaType===job.printableArtifact.mediaType&&(
        'producerKind' in checked
          ? 'producerKind' in job.production&&checked.producerKind===job.production.producerKind&&
            checked.mcpServer.name===job.production.mcpServer.name&&checked.mcpServer.version===job.production.mcpServer.version&&
            checked.catalogSha256===job.production.catalogSha256&&checked.tool===job.production.tool&&checked.slicerType===job.production.slicerType
          : !('producerKind' in job.production)&&checked.slicer.version===job.production.slicer.version&&checked.slicer.binarySha256===job.production.slicer.binarySha256);
      if(!sameRef(checked.sourceArtifact,job.designArtifact)||job.selection.slicerSettingsSha256!==checked.settingsArtifact.sha256||
        !sameRef(checked.sourceArtifact,job.production.sourceArtifact)||!sameRef(checked.settingsArtifact,job.production.settingsArtifact)||
        !sameRef(checked.manifestArtifact,job.production.manifestArtifact)||!evidenceMatches)
        throw new Error('Retained production evidence identity mismatch');
      if(job.production.printability){
        const report=await readBounded(join(folder,'printability.json'),1024*1024);
        if(!sameRef(refOf(report,'application/json'),job.production.printability.reportArtifact))
          throw new Error('Retained printability evidence identity mismatch');
      }
    }
    return bytes;
  }
  private async readIntent(job: PreparedJob): Promise<PreparedJobIntent | null> {
    let bytes: Buffer;
    try { bytes = await readBounded(join(this.directory, job.id, 'intent.json'), this.bound.maxMetadataBytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const intent = intentSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
    if (intent.jobSha256 !== job.sha256 || intent.jobId !== job.id ||
        intent.approval.jobSha256 !== job.sha256) {
      throw new Error('Stored intent does not match the prepared job');
    }
    return intent;
  }
}

export {createPreparedProducer} from './prepared-production.js';
export type {PreparedProducerConfiguration, PreparedProducer, PreparedProduction} from './prepared-production.js';
