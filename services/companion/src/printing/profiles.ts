import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
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
  /** The printer's model in the MCP's names (`p1s`), passed as `bambu_model` like the Mac app's own printer. */
  model: z.string().regex(/^[a-z0-9]{1,16}$/).optional(),
});
export type SavedProfile = z.infer<typeof SavedProfileSchema>;
export const SavedProfilesSchema = z.strictObject({
  version: z.literal(1),
  profiles: z.array(SavedProfileSchema).max(64),
  /** Per printer (its catalog key: `serial:…` or a host key), the MCP it uses when both reach it. */
  choices: z.record(z.string().max(300), printerBackendSchema),
});
export type SavedProfiles = z.infer<typeof SavedProfilesSchema>;

/**
 * The settings each MCP needs for a printer type, by the variable names it reads (first name canonical, then aliases):
 * bambu-printer-mcp's manifest `user_config` (all required) and mcp-3D-printer-server's .env.example / README.
 */
const BAMBU_REQUIRED: [string, ...string[]][] = [['PRINTER_HOST', 'BAMBU_PRINTER_HOST'], ['BAMBU_SERIAL', 'BAMBU_PRINTER_SERIAL'],
  ['BAMBU_TOKEN', 'BAMBU_PRINTER_ACCESS_TOKEN'], ['BAMBU_MODEL', 'BAMBU_PRINTER_MODEL']];
export function requiredSettings(backend: string, printerType: string | undefined): [string, ...string[]][] {
  if (backend === 'bambu-printer-mcp') return BAMBU_REQUIRED;
  if (printerType === 'bambu') return [['PRINTER_HOST'], ['BAMBU_SERIAL'], ['BAMBU_TOKEN'], ['BAMBU_MODEL']];
  return [['PRINTER_HOST']];
}
/** The Bambu route settings both MCPs read (bambu-printer-mcp; mcp-3D-printer-server from its feat/bambu-complete). */
export const ROUTE_KEYS = ['BAMBU_DEFAULT_CONNECTION_MODE', 'BAMBU_DEFAULT_CONNECTION_TYPE', 'BAMBU_NETWORK_BRIDGE_COMMAND', 'BAMBU_NETWORK_CONFIG_DIR'] as const;
/** Another MCP's authenticated route for the same printer: its raw `.env` lines (verbatim) and their values. */
export interface RouteSource {lines: Record<string, string>; values: Record<string, string>; from: string}

/**
 * The route lines of one `.env` when it uses FULU's authenticated route (`bambu_network` with a bridge command):
 * each line exactly as written, and only when that line alone reads as the same value as the whole file (no
 * multi-line value is cut). Nothing else in the file is ever taken.
 */
export function routeLines(text: string, from: string): RouteSource | undefined {
  let env: Record<string, string | undefined>;
  try { env = parseEnv(text); } catch { return undefined; }
  if (env.BAMBU_DEFAULT_CONNECTION_MODE?.trim() !== 'bambu_network' || !env.BAMBU_NETWORK_BRIDGE_COMMAND?.trim()) return undefined;
  const all = text.split(/\r?\n/);
  const lines: Record<string, string> = {}, values: Record<string, string> = {};
  for (const key of ROUTE_KEYS) {
    if (env[key] === undefined) continue;
    const line = [...all].reverse().find(item => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(item));
    let alone: string | undefined;
    try { alone = line === undefined ? undefined : parseEnv(line)[key]; } catch { alone = undefined; }
    if (line === undefined || alone !== env[key]) return undefined;
    lines[key] = line.trim(); values[key] = env[key]!;
  }
  return {lines, values, from};
}

/** Whether an MCP copy reads the route settings (older mcp-3D-printer-server releases don't): its entry names them. */
export async function readsRouteSettings(entry: string | undefined): Promise<boolean> {
  if (!entry) return false;
  try {
    if ((await stat(entry)).size > 32 * 1024 * 1024) return false;
    return (await readFile(entry, 'utf8')).includes('BAMBU_DEFAULT_CONNECTION_MODE');
  } catch { return false; }
}

/** The first of these `.env` files that is configured for the same Bambu serial and uses the authenticated route. */
export async function findBambuRoute(serial: string | undefined, envPaths: string[]): Promise<RouteSource | undefined> {
  if (!serial) return undefined;
  for (const path of new Set(envPaths)) {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    if (text.length > 256 * 1024) continue;
    let env: Record<string, string | undefined>;
    try { env = parseEnv(text); } catch { continue; }
    const theirs = (env.BAMBU_SERIAL ?? env.BAMBU_PRINTER_SERIAL)?.trim().toUpperCase();
    if (theirs !== serial.trim().toUpperCase()) continue;
    const route = routeLines(text, path);
    if (route) return route;
  }
  return undefined;
}

/**
 * What an MCP's `.env` lacks for its printer, and what Counterpart can fill without asking: the model, from
 * `model` (SSDP's DevModel or a choice) or else the serial number; and for an mcp-3D-printer-server Bambu printer
 * with no route of its own, `route`: the authenticated route another MCP config uses for the same serial (the
 * caller only passes one the target MCP reads). Never a secret, never a value already there. `lines` are what is appended.
 */
export function settingsGap(backend: string, env: Record<string, string | undefined>,
  options: {model?: string; modelFromSerial?: (serial?: string) => string | undefined; route?: RouteSource} = {}):
  {missing: string[]; fill: Record<string, string>; lines: Record<string, string>} {
  const value = (names: string[]) => names.map(name => env[name]?.trim()).find(item => !!item);
  const printerType = backend === 'bambu-printer-mcp' ? 'bambu' : value(['PRINTER_TYPE'])?.toLowerCase() ?? 'octoprint';
  const missing = requiredSettings(backend, printerType).filter(names => !value(names)).map(names => names[0]);
  const fill: Record<string, string> = {}, lines: Record<string, string> = {};
  if (missing.includes('BAMBU_MODEL')) {
    const model = options.model ?? options.modelFromSerial?.(value(['BAMBU_SERIAL', 'BAMBU_PRINTER_SERIAL']));
    if (model && /^[a-z0-9]{1,16}$/.test(model)) { fill.BAMBU_MODEL = model; lines.BAMBU_MODEL = `BAMBU_MODEL='${model}'`; }
  }
  if (options.route && backend === 'mcp-3d-printer-server' && printerType === 'bambu' && !value(['BAMBU_DEFAULT_CONNECTION_MODE'])) {
    for (const key of ROUTE_KEYS) if (options.route.lines[key] && env[key] === undefined) { fill[key] = options.route.values[key]!; lines[key] = options.route.lines[key]!; }
  }
  // A shared launcher may mount only the source MCP's authenticated session folder. Its default
  // must not silently become the generic MCP's different default, including for routes copied earlier.
  if (options.route && backend === 'mcp-3d-printer-server' && printerType === 'bambu'
      && (fill.BAMBU_DEFAULT_CONNECTION_MODE ?? value(['BAMBU_DEFAULT_CONNECTION_MODE'])) === 'bambu_network'
      && (fill.BAMBU_NETWORK_BRIDGE_COMMAND ?? value(['BAMBU_NETWORK_BRIDGE_COMMAND'])) === options.route.values.BAMBU_NETWORK_BRIDGE_COMMAND
      && !value(['BAMBU_NETWORK_CONFIG_DIR'])) {
    if (options.route.lines.BAMBU_NETWORK_CONFIG_DIR) {
      fill.BAMBU_NETWORK_CONFIG_DIR = options.route.values.BAMBU_NETWORK_CONFIG_DIR!;
      lines.BAMBU_NETWORK_CONFIG_DIR = options.route.lines.BAMBU_NETWORK_CONFIG_DIR;
    } else { missing.push('BAMBU_NETWORK_CONFIG_DIR'); }
  }
  return {missing, fill, lines};
}

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
