import { mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedProjectStorage } from '@scan-to-make/contracts/saved-project';

const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function checkId(id: string): void {
  if (typeof id !== 'string' || !validId.test(id)) throw new Error('Invalid saved project id');
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Portable project bytes with atomic CAS across cooperating local processes.
 * Use a dedicated, trusted local directory; an abandoned lock requires inspection.
 * This adapter does not authenticate requests or verify capture artifact bytes.
 */
export class FileSavedProjectStorage implements SavedProjectStorage {
  private readonly maxBytes: number;
  constructor(private readonly directory: string, options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 64 * 1024 * 1024) {
      throw new Error('Invalid saved project byte limit');
    }
  }

  async listIds(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && validId.test(entry.name.slice(0, -5)))
        .map(entry => entry.name.slice(0, -5)).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async read(id: string): Promise<string | null> {
    checkId(id);
    let file;
    try { file = await open(join(this.directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    try {
      if (!(await file.stat()).isFile()) throw new Error('Saved project must be a regular file');
      // Bound allocation and reads even if another local process changes the file.
      const bytes = Buffer.alloc(this.maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > this.maxBytes) throw new Error('Saved project exceeds byte limit');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await file.close(); }
  }

  async compareAndSwap(id: string, expected: string | null, next: string): Promise<boolean> {
    checkId(id);
    if (Buffer.byteLength(next, 'utf8') > this.maxBytes) throw new Error('Saved project exceeds byte limit');
    if (Buffer.from(next, 'utf8').toString('utf8') !== next) throw new Error('Saved project must contain valid Unicode');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, `${id}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Saved project is busy or has an interrupted write; inspect lock before recovery');
      }
      throw error;
    }
    try {
      if (await this.read(id) !== expected) return false;
      const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(next, 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(this.directory, `${id}.json`));
        const parent = await open(this.directory, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
        return true;
      } finally {
        // Never remove another writer's temporary data or an abandoned lock.
        await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
      }
    } finally { await rmdir(lock); }
  }
}
