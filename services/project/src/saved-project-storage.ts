import { mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeSavedProject, type SavedProjectStorage, type SavedProject } from '@scan-to-make/contracts/saved-project';

const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function checkId(id: string): void {
  if (typeof id !== 'string' || !validId.test(id)) throw new Error('Invalid saved project id');
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Lowercase base32 avoids case-folding collisions and stays below common 255-byte
// filename limits even for the maximum 128-byte project id. No padding is needed.
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
function fileKey(id: string): string {
  let buffer = 0, bits = 0, encoded = '';
  for (const byte of Buffer.from(id, 'utf8')) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; encoded += alphabet[(buffer >>> bits) & 31]; }
    buffer &= (1 << bits) - 1;
  }
  if (bits) encoded += alphabet[(buffer << (5 - bits)) & 31];
  return encoded;
}
function idFromKey(key: string): string | null {
  if (!/^[a-z2-7]{2,205}$/.test(key)) return null;
  let buffer = 0, bits = 0;
  const bytes: number[] = [];
  for (const character of key) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
    buffer &= (1 << bits) - 1;
  }
  const id = Buffer.from(bytes).toString('utf8');
  return validId.test(id) && fileKey(id) === key ? id : null;
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
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => idFromKey(entry.name.slice(0, -5)))
        .filter((id): id is string => id !== null).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async read(id: string): Promise<string | null> {
    checkId(id);
    let file;
    try { file = await open(join(this.directory, `${fileKey(id)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
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
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } finally { await file.close(); }
  }

  async compareAndSwap(id: string, expected: string | null, next: string): Promise<boolean> {
    checkId(id);
    if (Buffer.byteLength(next, 'utf8') > this.maxBytes) throw new Error('Saved project exceeds byte limit');
    if (Buffer.from(next, 'utf8').toString('utf8') !== next) throw new Error('Saved project must contain valid Unicode');
    return this.withLock(id, async () => {
      const key = fileKey(id);
      if (await this.read(id) !== expected) return false;
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(next, 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(this.directory, `${key}.json`));
        const parent = await open(this.directory, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
        return true;
      } finally {
        await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
      }
    });
  }

  /** Serialize a trusted attachment commit/read with all project edits.
   * The callback must not call another locking operation on this same project.
   * Historical attachment bytes remain separate from the portable project format.
   */
  async withCurrentProject<T>(id: string, expectedRevision: number,
    operation: (project: SavedProject) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid project revision');
    return this.withLock(id, async () => {
      const bytes = await this.read(id);
      const loaded = bytes === null ? { status: 'missing' as const } : decodeSavedProject(bytes, id);
      if (loaded.status !== 'ok') throw new Error(`Current project unavailable: ${loaded.status}`);
      if (loaded.project.revision !== expectedRevision) throw new Error('Stale project revision');
      return operation(loaded.project);
    });
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    checkId(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = fileKey(id);
    const lock = join(this.directory, `${key}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Saved project is busy or has an interrupted write; inspect lock before recovery');
      }
      throw error;
    }
    try { return await operation(); }
    finally { await rmdir(lock); }
  }
}
