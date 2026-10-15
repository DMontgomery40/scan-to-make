import {constants} from 'node:fs';
import {mkdir, open, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {PreparedJobFailure, PreparedJobStore, createPreparedProducer} from './prepared-jobs.js';
import {PRODUCTION_LIMITS, type PreparedProducer} from './prepared-production.js';
import {inspectorProcessSchema, readPrivateConfig} from './private-config.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().refine(isAbsolute);
const producerConfigSchema = z.strictObject({
  python: absolutePath,
  script: absolutePath,
  expectedScriptSha256: digest,
  bundle: absolutePath,
  expectedVersion: z.string().min(1).max(128),
  expectedBinarySha256: digest,
  machine: z.string().min(1).max(256),
  process: z.string().min(1).max(256),
  filament: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(120).optional(),
});

export interface ProduceRequest {
  captureDir: string;
  inspectorConfig: string;
  producerConfig: string;
  projectId: string;
  projectRevision: number;
  expectedProjectETag: string;
  jobId: string;
  stlPath: string;
  selectionPath: string;
}

const flags = [
  'capture-dir',
  'inspector-config',
  'producer-config',
  'project-id',
  'project-revision',
  'etag',
  'job-id',
  'stl',
  'selection',
] as const;

export function parseProduceArgs(argv: string[]): ProduceRequest {
  if (argv.length !== flags.length * 2) throw new Error('Invalid produce arguments');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error('Invalid produce arguments');
    const name = flag.slice(2);
    if (!(flags as readonly string[]).includes(name) || values.has(name) || value.startsWith('--')) {
      throw new Error('Invalid produce arguments');
    }
    values.set(name, value);
  }
  for (const name of flags) if (!values.has(name)) throw new Error('Invalid produce arguments');
  const revision = Number(values.get('project-revision'));
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid produce arguments');
  return {
    captureDir: values.get('capture-dir')!,
    inspectorConfig: values.get('inspector-config')!,
    producerConfig: values.get('producer-config')!,
    projectId: values.get('project-id')!,
    projectRevision: revision,
    expectedProjectETag: values.get('etag')!,
    jobId: values.get('job-id')!,
    stlPath: values.get('stl')!,
    selectionPath: values.get('selection')!,
  };
}

async function readAbsoluteBytes(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('Produce input path must be absolute');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('Produce input file byte limit exceeded');
    const bytes = Buffer.alloc(Math.min(maxBytes + 1, Number(stat.size) + 1));
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length !== stat.size || length > maxBytes) throw new Error('Produce input file byte limit exceeded');
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

async function withJobProduceLock<T>(directory: string, jobId: string, operation: () => Promise<T>): Promise<T> {
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

export async function runProduce(
  request: ProduceRequest,
  options: {producer?: PreparedProducer} = {},
): Promise<{jobId: string; jobSha256: string; created: boolean}> {
  if (!isAbsolute(request.captureDir) || !isAbsolute(request.inspectorConfig) || !isAbsolute(request.producerConfig)) {
    throw new Error('Produce paths must be absolute');
  }
  const inspection = await readPrivateConfig(request.inspectorConfig, inspectorProcessSchema, 'Inspector configuration');
  const producerConfig = await readPrivateConfig(request.producerConfig, producerConfigSchema, 'Producer configuration');
  const source = await readAbsoluteBytes(request.stlPath, PRODUCTION_LIMITS.sourceBytes);
  const selection = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readAbsoluteBytes(request.selectionPath, 65536)));
  const production = options.producer ?? createPreparedProducer(producerConfig);
  const jobsDir = join(request.captureDir, 'prepared-jobs');
  return withJobProduceLock(jobsDir, request.jobId, async () => {
    const storage = new FileSavedProjectStorage(join(request.captureDir, 'projects'));
    const store = new PreparedJobStore(storage, jobsDir, {inspection: {process: inspection}, production});
    const result = await store.prepareProduced({
      projectId: request.projectId,
      projectRevision: request.projectRevision,
      expectedProjectETag: request.expectedProjectETag,
      jobId: request.jobId,
      source,
      selection,
    });
    return {jobId: result.jobId, jobSha256: result.job.sha256, created: result.created};
  });
}

async function main(): Promise<void> {
  try {
    const result = await runProduce(parseProduceArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof PreparedJobFailure ? error.code : undefined;
    process.stderr.write(code ? `Prepared produce failed (${code}).\n` : 'Prepared produce failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
