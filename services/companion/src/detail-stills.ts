import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FileSavedProjectStorage } from '@scan-to-make/project';
import { CaptureBindingSchema } from '@scan-to-make/contracts/capture';
import {
  DetailStillSchema,
  validateDetailStills,
  MAX_DETAIL_STILL_BYTES,
  MAX_DETAIL_STILLS_PER_CAPTURE,
  DETAIL_STILL_SCHEMA_ID,
  type DetailStill,
} from '@scan-to-make/contracts/detail-still';
import { readBoundedCaptureFile } from './capture-import.js';

export class DetailStillFailure extends Error {
  constructor(
    readonly code:
      | 'not-found'
      | 'still-limit'
      | 'unsupported-media-type'
      | 'invalid-still'
      | 'payload-too-large'
      | 'still-unavailable'
  ) {
    super(code);
  }
}

const requestSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  projectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  captureId: z.uuid(),
});
const stillIdSchema = z.uuid();
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_BINDING_BYTES = 1024 * 1024;
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevm', 'hevs', 'mif1', 'mif2']);

/** Magic-byte sniffing only; this does not decode or validate image content. */
export function sniffDetailStillMediaType(bytes: Uint8Array): DetailStill['mediaType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((value, index) => bytes[index] === value)) {
    return 'image/png';
  }
  if (bytes.length >= 12) {
    const box = String.fromCharCode(...bytes.subarray(4, 8));
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (box === 'ftyp' && HEIC_BRANDS.has(brand)) return 'image/heic';
  }
  return null;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const abort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Detail still operation aborted');
};

async function writeSynced(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function fileSize(path: string): Promise<number> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new DetailStillFailure('still-unavailable');
    return info.size;
  } finally {
    await file.close();
  }
}

const HIGH_WATER_FILE = '.ordinal-high-water';

/** Highest ordinal ever assigned for a capture, or -1. Persisted so deletions never rewind attachment order. */
async function readHighWater(folder: string): Promise<number> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedCaptureFile(join(folder, HIGH_WATER_FILE), 64);
  } catch (error) {
    if (isMissing(error)) return -1;
    throw new DetailStillFailure('still-unavailable');
  }
  const text = bytes.toString('utf8').trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new DetailStillFailure('still-unavailable');
  }
  return Number(text);
}

interface StillRequest {
  projectId: string;
  projectRevision: number;
  captureId: string;
}

/**
 * Retained detail stills live beside the capture bundle they annotate:
 * `<captureDirectory>/<captureId>/detail-stills/<stillId>.{img,json}`.
 * The JSON record is the commit point; it is renamed into place only after
 * the image bytes are synced. Every operation runs under the same project
 * lock as capture import and project edits, so a stale revision cannot
 * attach, read or delete stills. This local API is not an authenticated
 * network endpoint.
 */
export class DetailStillStore {
  constructor(
    private readonly projects: FileSavedProjectStorage,
    private readonly captureDirectory: string
  ) {}

  private folder(request: StillRequest): string {
    return join(this.captureDirectory, request.captureId, 'detail-stills');
  }

  /** The capture must already be retained for this exact project revision. */
  private async verifyCapture(request: StillRequest): Promise<void> {
    let bindingBytes: Buffer;
    try {
      bindingBytes = await readBoundedCaptureFile(
        join(this.captureDirectory, request.captureId, 'binding.json'),
        MAX_BINDING_BYTES
      );
    } catch (error) {
      if (isMissing(error)) throw new DetailStillFailure('not-found');
      throw new DetailStillFailure('still-unavailable');
    }
    let binding: unknown;
    try {
      binding = CaptureBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')));
    } catch {
      throw new DetailStillFailure('still-unavailable');
    }
    const parsed = binding as { projectId: string; projectRevision: number };
    if (parsed.projectId !== request.projectId || parsed.projectRevision !== request.projectRevision) {
      throw new DetailStillFailure('not-found');
    }
  }

  private async readRecord(request: StillRequest, stillId: string): Promise<DetailStill> {
    let bytes: Buffer;
    try {
      bytes = await readBoundedCaptureFile(join(this.folder(request), `${stillId}.json`), MAX_METADATA_BYTES);
    } catch (error) {
      if (isMissing(error)) throw new DetailStillFailure('not-found');
      throw new DetailStillFailure('still-unavailable');
    }
    let still: DetailStill;
    try {
      still = DetailStillSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new DetailStillFailure('still-unavailable');
    }
    if (
      still.id !== stillId ||
      still.projectId !== request.projectId ||
      still.captureId !== request.captureId ||
      still.projectRevision !== request.projectRevision
    ) {
      throw new DetailStillFailure('still-unavailable');
    }
    return still;
  }

  /** Validated records in attachment order. Orphan bytes without a record are never served. */
  private async readAll(request: StillRequest): Promise<DetailStill[]> {
    let names: string[];
    try {
      names = await readdir(this.folder(request));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records: DetailStill[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const match = /^([0-9a-fA-F-]{36})\.(json|img)$/.exec(name);
      if (!match) throw new DetailStillFailure('still-unavailable');
      if (match[2] === 'json') records.push(await this.readRecord(request, match[1]!));
    }
    records.sort((a, b) => a.ordinal - b.ordinal);
    let validated: DetailStill[];
    try {
      validated = validateDetailStills(records);
    } catch {
      throw new DetailStillFailure('still-unavailable');
    }
    for (const still of validated) {
      let size: number;
      try {
        size = await fileSize(join(this.folder(request), `${still.id}.img`));
      } catch (error) {
        if (error instanceof DetailStillFailure) throw error;
        throw new DetailStillFailure('still-unavailable');
      }
      if (size !== still.byteLength) throw new DetailStillFailure('still-unavailable');
    }
    return validated;
  }

  private checkETag(expectedProjectETag?: string): void {
    if (expectedProjectETag !== undefined && !/^"[a-f0-9]{64}"$/.test(expectedProjectETag)) {
      throw new Error('Invalid project snapshot ETag');
    }
  }

  async addDetailStill(
    input: StillRequest & { label?: string; source: Uint8Array; expectedProjectETag?: string },
    signal?: AbortSignal,
    authorizeCommit?: () => Promise<void>
  ): Promise<{ still: DetailStill }> {
    const request = requestSchema.parse(input);
    this.checkETag(input.expectedProjectETag);
    abort(signal);
    if (!(input.source instanceof Uint8Array)) throw new DetailStillFailure('invalid-still');
    if (input.source.byteLength > MAX_DETAIL_STILL_BYTES) throw new DetailStillFailure('payload-too-large');
    const bytes = Buffer.from(input.source); // Snapshot before any asynchronous operation.
    const mediaType = sniffDetailStillMediaType(bytes);
    if (!mediaType) throw new DetailStillFailure('unsupported-media-type');
    const label = input.label;
    if (label !== undefined && !DetailStillSchema.shape.label.safeParse(label).success) {
      throw new DetailStillFailure('invalid-still');
    }
    const digest = sha256(bytes);
    // Fail on a stale or missing project before writing anything.
    await this.projects.withCurrentProject(
      request.projectId, request.projectRevision, async () => undefined, input.expectedProjectETag
    );
    return this.projects.withCurrentProject(
      request.projectId,
      request.projectRevision,
      async () => {
        await this.verifyCapture(request);
        const folder = this.folder(request);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        // Remove orphan bytes from an interrupted earlier commit; they have no record.
        const existing = await this.readAll(request);
        const known = new Set(existing.map((still) => still.id));
        for (const name of await readdir(folder)) {
          const orphan = /^([0-9a-fA-F-]{36})\.img$/.exec(name);
          if (orphan && !known.has(orphan[1]!)) await unlink(join(folder, name)).catch(() => undefined);
          if (name.startsWith('.tmp-')) await rm(join(folder, name), { force: true }).catch(() => undefined);
        }
        if (existing.length >= MAX_DETAIL_STILLS_PER_CAPTURE) throw new DetailStillFailure('still-limit');
        const highWater = await readHighWater(folder);
        const still: DetailStill = DetailStillSchema.parse({
          schema: DETAIL_STILL_SCHEMA_ID,
          id: randomUUID(),
          projectId: request.projectId,
          captureId: request.captureId,
          projectRevision: request.projectRevision,
          mediaType,
          byteLength: bytes.length,
          sha256: digest,
          ...(label !== undefined ? { label } : {}),
          ordinal: Math.max(highWater, ...existing.map((entry) => entry.ordinal)) + 1,
        });
        const imagePath = join(folder, `${still.id}.img`);
        const recordPath = join(folder, `${still.id}.json`);
        const imageTemp = join(folder, `.tmp-${randomUUID()}`);
        const recordTemp = join(folder, `.tmp-${randomUUID()}`);
        const highWaterTemp = join(folder, `.tmp-${randomUUID()}`);
        let committed = false;
        try {
          abort(signal);
          await writeSynced(imageTemp, bytes);
          await writeSynced(recordTemp, Buffer.from(JSON.stringify(still) + '\n'));
          await authorizeCommit?.();
          abort(signal);
          await rename(imageTemp, imagePath);
          await writeSynced(highWaterTemp, Buffer.from(`${still.ordinal}\n`));
          await rename(highWaterTemp, join(folder, HIGH_WATER_FILE));
          // The record rename is the commit point. A later abort cannot undo it.
          await rename(recordTemp, recordPath);
          committed = true;
          await syncDirectory(folder);
          return { still };
        } finally {
          await rm(imageTemp, { force: true }).catch(() => undefined);
          await rm(recordTemp, { force: true }).catch(() => undefined);
          await rm(highWaterTemp, { force: true }).catch(() => undefined);
          if (!committed) await unlink(imagePath).catch(() => undefined);
        }
      },
      input.expectedProjectETag
    );
  }

  async listDetailStills(
    projectId: string, projectRevision: number, captureId: string, expectedProjectETag?: string
  ): Promise<{ captureId: string; stills: DetailStill[] }> {
    const request = requestSchema.parse({ projectId, projectRevision, captureId });
    this.checkETag(expectedProjectETag);
    return this.projects.withCurrentProject(projectId, projectRevision, async () => {
      await this.verifyCapture(request);
      return { captureId, stills: await this.readAll(request) };
    }, expectedProjectETag);
  }

  /** Exact bytes, hash- and type-verified against the retained record before serving. */
  async loadDetailStill(
    projectId: string, projectRevision: number, captureId: string, stillId: string, expectedProjectETag?: string
  ): Promise<{ still: DetailStill; bytes: Buffer }> {
    const request = requestSchema.parse({ projectId, projectRevision, captureId });
    stillIdSchema.parse(stillId);
    this.checkETag(expectedProjectETag);
    return this.projects.withCurrentProject(projectId, projectRevision, async () => {
      await this.verifyCapture(request);
      const still = await this.readRecord(request, stillId);
      let bytes: Buffer;
      try {
        bytes = await readBoundedCaptureFile(join(this.folder(request), `${stillId}.img`), MAX_DETAIL_STILL_BYTES);
      } catch {
        throw new DetailStillFailure('still-unavailable');
      }
      if (
        bytes.length !== still.byteLength ||
        sha256(bytes) !== still.sha256 ||
        sniffDetailStillMediaType(bytes) !== still.mediaType
      ) {
        throw new DetailStillFailure('still-unavailable');
      }
      return { still, bytes };
    }, expectedProjectETag);
  }

  async deleteDetailStill(
    projectId: string,
    projectRevision: number,
    captureId: string,
    stillId: string,
    expectedProjectETag?: string,
    signal?: AbortSignal,
    authorizeCommit?: () => Promise<void>
  ): Promise<{ still: DetailStill }> {
    const request = requestSchema.parse({ projectId, projectRevision, captureId });
    stillIdSchema.parse(stillId);
    this.checkETag(expectedProjectETag);
    abort(signal);
    return this.projects.withCurrentProject(projectId, projectRevision, async () => {
      await this.verifyCapture(request);
      const still = await this.readRecord(request, stillId);
      await authorizeCommit?.();
      abort(signal);
      const folder = this.folder(request);
      // Removing the record is the commit point; orphan bytes are then unservable.
      await unlink(join(folder, `${stillId}.json`));
      await unlink(join(folder, `${stillId}.img`)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      await syncDirectory(folder);
      return { still };
    }, expectedProjectETag);
  }
}
