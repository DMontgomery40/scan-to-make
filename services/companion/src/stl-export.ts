import { constants } from 'node:fs';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateArtifactRef, type ArtifactRef } from '@scan-to-make/contracts';
import type { ProjectStore } from '@scan-to-make/project';

type Point = readonly [number, number, number];
export interface StlGeometrySummary {
  readonly encoding: 'ascii' | 'binary';
  readonly triangleCount: number;
  readonly boundsMm: Readonly<{ min: Point; max: Point }>;
}
export interface AcceptedStlExport {
  readonly projectId: string;
  readonly specRevision: number;
  readonly artifact: ArtifactRef;
  readonly outputPath: string;
  readonly geometry: StlGeometrySummary;
}
export interface StlExportRequest {
  projectId: string;
  expectedRevision: number;
  sourcePath: string;
  outputPath: string;
}
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TRIANGLES = 500_000;
function badGeometry(): never { throw new Error('Invalid STL structure or nonfinite/degenerate geometry'); }
function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mediaType === b.mediaType;
}

/** Structural sanity only. Open meshes can pass: this is not a printability test. */
function inspectStl(bytes: Buffer): StlGeometrySummary {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  function triangle(normal: number[], points: number[][]): void {
    if (++count > MAX_TRIANGLES || !normal.every(Number.isFinite)
        || points.some(p => p.length !== 3 || !p.every(Number.isFinite))) badGeometry();
    const [a, b, c] = points as [number[], number[], number[]];
    const u = b.map((n, i) => n - a[i]!);
    const v = c.map((n, i) => n - a[i]!);
    const area2 = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    if (!Number.isFinite(area2) || area2 === 0) badGeometry();
    for (const point of points) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, point[i]!); max[i] = Math.max(max[i]!, point[i]!);
    }
  }
  let encoding: 'ascii' | 'binary';
  const declared = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  if (bytes.length >= 84 && bytes.length === 84 + declared * 50) {
    encoding = 'binary';
    if (declared === 0 || declared > MAX_TRIANGLES) badGeometry();
    for (let facet = 0; facet < declared; facet++) {
      const start = 84 + facet * 50;
      const vector = (offset: number) => [0, 4, 8].map(i => bytes.readFloatLE(start + offset + i));
      triangle(vector(0), [vector(12), vector(24), vector(36)]);
    }
  } else {
    encoding = 'ascii';
    const text = bytes.toString('latin1');
    if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) badGeometry();
    // Stream lines rather than allocating one token array for the entire mesh.
    const lines = text.matchAll(/[^\r\n]+/g);
    const next = (): string | undefined => {
      for (let n = lines.next(); !n.done; n = lines.next()) {
        const line = n.value[0].trim(); if (line) return line;
      }
      return undefined;
    };
    const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
    const normalPattern = new RegExp(`^facet\\s+normal\\s+(${number})\\s+(${number})\\s+(${number})$`);
    const vertexPattern = new RegExp(`^vertex\\s+(${number})\\s+(${number})\\s+(${number})$`);
    const parse = (line: string | undefined, pattern: RegExp): number[] => {
      const match = line?.match(pattern); if (!match) return badGeometry();
      return match.slice(1).map(Number);
    };
    if (!/^solid(?:\s.*)?$/.test(next() ?? '')) badGeometry();
    while (true) {
      const line = next();
      if (line === undefined) badGeometry();
      if (/^endsolid(?:\s.*)?$/.test(line)) { if (next() !== undefined) badGeometry(); break; }
      const normal = parse(line, normalPattern);
      if (next() !== 'outer loop') badGeometry();
      const points = [parse(next(), vertexPattern), parse(next(), vertexPattern), parse(next(), vertexPattern)];
      if (next() !== 'endloop' || next() !== 'endfacet') badGeometry();
      triangle(normal, points);
    }
  }
  if (count === 0) badGeometry();
  return Object.freeze({ encoding, triangleCount: count, boundsMm: Object.freeze({
    min: Object.freeze(min) as unknown as Point, max: Object.freeze(max) as unknown as Point,
  }) });
}

async function readBoundedSnapshot(path: string, artifact: ArtifactRef): Promise<Buffer> {
  if (artifact.byteLength < 1 || artifact.byteLength > MAX_BYTES) throw new Error('STL export byte limit exceeded');
  // Do not follow a source symlink, including on platforms without O_NOFOLLOW.
  if (!(await lstat(path)).isFile()) throw new Error('STL source must be a regular file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error('STL source must be a regular file');
    const snapshot = Buffer.alloc(artifact.byteLength + 1);
    let length = 0;
    while (length < snapshot.length) {
      const result = await file.read(snapshot, length, snapshot.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== artifact.byteLength) throw new Error('Accepted artifact bytes do not match');
    const bytes = snapshot.subarray(0, length);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Accepted artifact bytes do not match');
    return bytes;
  } finally { await file.close(); }
}

/** Trusted local path only; captures bounded exact bytes and checks STL structure, not printability. */
export async function readVerifiedStl(path: string, input: ArtifactRef): Promise<{bytes: Buffer; geometry: StlGeometrySummary}> {
  const artifact = validateArtifactRef(input);
  const bytes = await readBoundedSnapshot(path, artifact);
  return {bytes, geometry: inspectStl(bytes)};
}

/**
 * Export exact accepted STL bytes for an explicit project revision. The caller
 * authenticates project access and authorizes the local output path. STL carries
 * no unit metadata: coordinates are interpreted in the FitSpec's declared mm.
 * This receipt proves structure and identity, not fit, watertightness or safety.
 */
export async function exportAcceptedStl(projects: Pick<ProjectStore, 'load'>, input: StlExportRequest): Promise<AcceptedStlExport> {
  const request = { ...input }; // bind caller-selected paths/revision across awaits
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('Invalid expected project revision');
  const initial = await projects.load(request.projectId);
  if (initial.spec.revision !== request.expectedRevision) throw new Error('Stale project revision');
  if (!initial.acceptedArtifact) throw new Error('Project requires an accepted artifact');
  const artifact = initial.acceptedArtifact.artifact;
  if (artifact.mediaType !== 'model/stl') throw new Error('Accepted artifact must be STL');
  const {bytes, geometry} = await readVerifiedStl(request.sourcePath, artifact);
  const outputPath = resolve(request.outputPath);
  const temporary = join(dirname(outputPath), `.accepted-stl-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    const current = await projects.load(request.projectId);
    if (current.spec.revision !== request.expectedRevision) throw new Error('Stale project revision');
    if (!current.acceptedArtifact || !sameArtifact(current.acceptedArtifact.artifact, artifact)) throw new Error('Project acceptance changed');
    await link(temporary, outputPath); // exclusive publication; no overwrite even under concurrency
    return Object.freeze({ projectId: request.projectId, specRevision: request.expectedRevision,
      artifact: Object.freeze({ ...artifact }), outputPath, geometry });
  } finally { await unlink(temporary).catch(() => undefined); }
}
