import {constants} from 'node:fs';
import {mkdir, open, rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {PreparedJobFailure, PreparedJobStore, createPreparedProducer, withJobProduceLock} from './prepared-jobs.js';
import {PRODUCTION_LIMITS, preparedProducerConfigurationSchema, type PreparedProducer} from './prepared-production.js';
import {preparedPrintabilityConfigurationSchema} from './prepared-printability.js';
import {inspectorProcessSchema, readPrivateConfig} from './private-config.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().refine(isAbsolute);
const producerConfigSchema = preparedProducerConfigurationSchema;

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
  allowSupports: boolean;
  printabilityConfig?: string;
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
  const values = new Map<string, string>();
  let allowSupports = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag?.startsWith('--')) throw new Error('Invalid produce arguments');
    const name = flag.slice(2);
    if (name === 'allow-supports') {
      if (allowSupports) throw new Error('Invalid produce arguments');
      allowSupports = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error('Invalid produce arguments');
    if (!(flags as readonly string[]).includes(name) && name !== 'printability-config' || values.has(name) || value.startsWith('--')) {
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
    allowSupports,
    printabilityConfig: values.get('printability-config'),
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

export async function runProduce(
  request: ProduceRequest,
  options: {producer?: PreparedProducer} = {},
): Promise<{jobId: string; jobSha256: string; created: boolean}> {
  // Validate before the ID becomes a filesystem lock path.
  const jobId = z.uuid().parse(request.jobId).toLowerCase();
  if (!isAbsolute(request.captureDir) || !isAbsolute(request.inspectorConfig) || !isAbsolute(request.producerConfig)) {
    throw new Error('Produce paths must be absolute');
  }
  const inspection = await readPrivateConfig(request.inspectorConfig, inspectorProcessSchema, 'Inspector configuration');
  const producerConfig = await readPrivateConfig(request.producerConfig, producerConfigSchema, 'Producer configuration');
  const printability = request.printabilityConfig === undefined ? undefined :
    await readPrivateConfig(request.printabilityConfig, preparedPrintabilityConfigurationSchema, 'Printability configuration');
  const source = await readAbsoluteBytes(request.stlPath, PRODUCTION_LIMITS.sourceBytes);
  const selection = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readAbsoluteBytes(request.selectionPath, 65536)));
  const production = options.producer ?? createPreparedProducer(producerConfig);
  const jobsDir = join(request.captureDir, 'prepared-jobs');
  return withJobProduceLock(jobsDir, jobId, async () => {
    const storage = new FileSavedProjectStorage(join(request.captureDir, 'projects'));
    const store = new PreparedJobStore(storage, jobsDir, {inspection: {process: inspection}, production, printability});
    const result = await store.prepareProduced({
      projectId: request.projectId,
      projectRevision: request.projectRevision,
      expectedProjectETag: request.expectedProjectETag,
      jobId,
      source,
      selection,
      allowSupports: request.allowSupports,
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
