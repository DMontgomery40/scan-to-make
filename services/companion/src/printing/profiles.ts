import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';
import {printerBackendSchema} from '@scan-to-make/printer-handoff';

/**
 * Printers added in Counterpart (Settings → Printers → Add printer…): `<appPrinters>/profiles.json`. Each runs one
 * printer MCP where its settings are: its own folder's `.env`, read by the MCP itself (dotenv). Counterpart keeps
 * no copy of those settings, only how to start the MCP, and which MCP a printer reachable through both uses.
 */
export const SavedProfileSchema = z.strictObject({
  id: z.string().regex(/^counterpart-[0-9a-f-]{36}$/),
  name: z.string().min(1).max(120),
  backend: printerBackendSchema,
  process: z.strictObject({command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(16), cwd: z.string().min(1).max(4096)}),
  /** Counterpart made its folder (`<appPrinters>/profiles/<id>`): Remove deletes it. A folder found on the Mac stays. */
  owned: z.boolean(),
});
export type SavedProfile = z.infer<typeof SavedProfileSchema>;
export const SavedProfilesSchema = z.strictObject({
  version: z.literal(1),
  profiles: z.array(SavedProfileSchema).max(64),
  /** Per printer (its catalog key: `serial:…` or a host key), the MCP it uses when both reach it. */
  choices: z.record(z.string().max(300), printerBackendSchema),
});
export type SavedProfiles = z.infer<typeof SavedProfilesSchema>;

export const EMPTY_PROFILES: SavedProfiles = {version: 1, profiles: [], choices: {}};
export const newProfileId = () => `counterpart-${randomUUID()}`;

/** A missing or unreadable list is an empty one: printers from the user's MCP configs still load. */
export async function readProfiles(path: string): Promise<SavedProfiles> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 1024 * 1024) return structuredClone(EMPTY_PROFILES);
    const parsed = SavedProfilesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : structuredClone(EMPTY_PROFILES);
  } catch { return structuredClone(EMPTY_PROFILES); }
}

let writes: Promise<void> = Promise.resolve();
/** One change at a time, each read, changed and written in full (atomically) before the next. */
export function changeProfiles<T>(path: string, change: (state: SavedProfiles) => T | Promise<T>): Promise<T> {
  const work = writes.then(async () => {
    const state = await readProfiles(path);
    const result = await change(state);
    SavedProfilesSchema.parse(state);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1) + '\n', {mode: 0o600});
    await rename(temporary, path);
    return result;
  });
  writes = work.then(() => undefined, () => undefined);
  return work;
}
