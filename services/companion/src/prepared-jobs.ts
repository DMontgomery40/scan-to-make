import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, link, mkdir, mkdtemp, open, opendir, rename, rm, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {ArtifactRefSchema, type ArtifactRef} from '@scan-to-make/contracts';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {PrintSelectionSchema} from './index.js';
import {PreparedInspectionSchema, createPreparedFileInspector, printableFormat, type PreparedInspectionConfiguration} from './prepared-inspection.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const etag = z.string().regex(/^"[a-f0-9]{64}"$/);

const preparedJobBody = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  id: z.uuid(),
  projectId,
  projectRevision: integer,
  designArtifact: ArtifactRefSchema,
  printableArtifact: ArtifactRefSchema,
  selection: PrintSelectionSchema,
  inspection: PreparedInspectionSchema.optional(),
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
  constructor(readonly code: 'not-found' | 'job-conflict' | 'cancelled' | 'invalid-cursor' | 'cursor-stale' | 'discovery-unavailable') {super(code);}
}

const discoveryCursor = z.strictObject({version: z.literal(1), projectId, projectRevision: integer,
  etag, catalog: digest, after: z.uuid()});
const DISCOVERY = {directoryEntries: 4096, records: 200, metadataBytes: 8 * 1024 * 1024,
  pageSize: 50, summaryBytes: 1024, responseBytes: 64 * 1024, timeoutMs: 5000};

export type PreparedJob = z.infer<typeof PreparedJobSchema>;
export type PreparedJobApproval = z.infer<typeof approvalSchema>;
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
  private readonly inspect?: ReturnType<typeof createPreparedFileInspector>;
  constructor(private readonly projects: FileSavedProjectStorage, private readonly directory: string,
    options: PreparedJobLimits & {clock?: () => number; inspection?: PreparedInspectionConfiguration} = {}) {
    const {clock, inspection, ...byteLimits} = options;
    this.inspect = inspection ? createPreparedFileInspector(inspection) : undefined;
    this.bound = limits(byteLimits);
    this.clock = clock ?? Date.now;
  }

  get inspectionEnabled(): boolean { return this.inspect !== undefined; }
  get maxPrintableBytes(): number { return this.bound.maxPrintableBytes; }

  async prepare(input: {projectId: string; projectRevision: number; printable: Uint8Array;
      printableArtifact: unknown; selection: unknown; expectedProjectETag?: string; jobId?: string},
      signal?: AbortSignal, authorizeCommit?: () => Promise<void>):
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
          if (existing.projectId !== request.projectId || existing.projectRevision !== request.projectRevision ||
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
          selection: request.selection, ...(inspection ? {inspection} : {}),
        });
        const job = PreparedJobSchema.parse({...body, sha256: hashPreparedJob(body)});
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
      limit?: number; cursor?: string}, signal?: AbortSignal) {
    const request = z.strictObject({projectId, projectRevision: integer, expectedProjectETag: etag,
      limit: z.number().int().min(1).max(DISCOVERY.pageSize).default(20), cursor: z.string().max(1024).optional()}).parse(input);
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
        cursor = discoveryCursor.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
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
      while (position < entries.length && scanned < DISCOVERY.records && jobs.length < request.limit && budget >= this.bound.maxMetadataBytes) {
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
          budget -= bytes?.length ?? this.bound.maxMetadataBytes;
          continue;
        }
        budget -= bytes.length;
        if (job.projectId !== request.projectId || job.projectRevision !== request.projectRevision ||
            !sameRef(job.designArtifact, project.acceptedArtifact.artifact) || !job.inspection) continue;
        const summary = {jobId: job.id, jobSha256: job.sha256, printableArtifact: job.printableArtifact,
          model: job.selection.model, plateIndex: job.selection.plateIndex};
        if (Buffer.byteLength(JSON.stringify(summary)) > DISCOVERY.summaryBytes) {unreadable++; continue;}
        jobs.push(summary);
      }
      assertActive();
      const nextCursor = position < entries.length ? Buffer.from(JSON.stringify({version: 1,
        projectId: request.projectId, projectRevision: request.projectRevision, etag: request.expectedProjectETag,
        catalog, after: entries[position - 1]!.id})).toString('base64url') : null;
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
