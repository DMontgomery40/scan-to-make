import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

export const PRIVATE_CONFIG_MAX_BYTES = 65536;
const absolutePath = z.string().refine(isAbsolute);
export const inspectorProcessSchema = z.strictObject({
  command: absolutePath,
  args: z.array(z.string()).max(256).optional(),
  cwd: absolutePath.optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type InspectorProcessConfiguration = z.infer<typeof inspectorProcessSchema>;

/** Owner-only, no-follow, size-bounded strict JSON. Callers supply the schema. */
export async function readPrivateConfig<T>(file: string, schema: z.ZodType<T>, label: string): Promise<T> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PRIVATE_CONFIG_MAX_BYTES || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error(`${label} must be a private regular file`);
    }
    const bytes = Buffer.alloc(PRIVATE_CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > PRIVATE_CONFIG_MAX_BYTES) throw new Error(`${label} exceeds byte limit`);
    return schema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))));
  } finally {
    await handle.close();
  }
}
