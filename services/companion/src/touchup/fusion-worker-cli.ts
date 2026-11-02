import {readFile} from 'node:fs/promises';
import {printerHandoffConfigSchema, serveBoundFusion} from '@scan-to-make/printer-handoff';

try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('A pass binding file is required');
  const source = await readFile(path, 'utf8');
  if (Buffer.byteLength(source) > 65536) throw new Error('Pass binding exceeds byte limit');
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || !('handoff' in value) || !('documentId' in value) || typeof value.documentId !== 'string')
    throw new Error('Invalid pass binding');
  await serveBoundFusion(printerHandoffConfigSchema.parse(value.handoff), value.documentId);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Fusion worker bridge failed'}\n`);
  process.exitCode = 1;
}
