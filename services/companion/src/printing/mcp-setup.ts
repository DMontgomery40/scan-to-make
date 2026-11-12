import {z} from 'zod';
import type {PrinterBackend} from '@scan-to-make/printer-handoff';

/**
 * What each printer MCP says it needs to drive a printer (`counterpart_setup_fields`, docs/protocols/mcp-contract.md):
 * the printer kinds it drives, the `.env` settings it reads for each, its model choices, the model each serial
 * prefix names, and the slicer it would run. Add printer… is built from this; the companion keeps no printer,
 * model or slicer tables of its own (PRD §8.0 item 6).
 */
const FieldSchema = z.object({
  name: z.string().min(1).max(32),
  env: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  aliases: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(8).optional(),
  label: z.string().min(1).max(120),
  hint: z.string().max(400).optional(),
  required: z.boolean(),
  input: z.string().max(16).optional(),
  transform: z.string().max(16).optional(),
  choices: z.array(z.object({value: z.string().min(1).max(64), label: z.string().min(1).max(120)})).max(64).optional(),
  fromSerial: z.object({prefixLength: z.number().int().min(1).max(16), models: z.record(z.string().max(16), z.string().max(64))}).optional(),
  /**
   * A value the MCP can fetch instead of the person typing it (mcp-3d-printer-server 1.2.51+: OctoPrint's key, approved in
   * OctoPrint): the tool to call with the form's host and port, and the button's words. `printers.obtain` runs it.
   */
  obtain: z.object({tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label: z.string().min(1).max(60), hint: z.string().max(200).optional()}).optional(),
});
export type SetupField = z.infer<typeof FieldSchema>;
const KindSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(120),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(256)),
  /** The kind the MCP runs when a .env sets none of its kinds' fixed values (mcp-3d-printer-server 1.2.50+). */
  default: z.boolean().optional(),
  /**
   * Whether camera_snapshot reads this kind's camera with only the settings its fields write, so Check asks for a
   * picture (bambu-printer-mcp 1.1.82+, mcp-3d-printer-server 1.2.63+). Missing: an MCP to update.
   */
  cameraSnapshot: z.boolean().optional(),
  fields: z.array(FieldSchema).max(32),
});
export type SetupKind = z.infer<typeof KindSchema>;
const SlicerSchema = z.object({
  type: z.string().max(64), path: z.string().max(4096).optional(), found: z.boolean(),
  profilesRoot: z.string().max(4096).optional(), profilesFound: z.boolean().optional(),
  fields: z.array(FieldSchema).max(16),
});
export type SlicerSetup = z.infer<typeof SlicerSchema>;
export const McpSetupSchema = z.object({
  contract: z.literal('counterpart/1'),
  server: z.object({name: z.string().max(128), version: z.string().max(64)}),
  kinds: z.array(KindSchema).max(32),
  model: z.string().max(64).optional(),
  slicer: SlicerSchema.optional(),
});
export type McpSetup = z.infer<typeof McpSetupSchema>;

export function readMcpSetup(value: unknown): McpSetup | undefined {
  const parsed = McpSetupSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const field = (kind: SetupKind | undefined, name: string) => kind?.fields.find(item => item.name === name);
/** The variable names an MCP reads for a field: its older aliases first (they win when set), then `env`. */
export const names = (item: SetupField): [string, ...string[]] => [...(item.aliases ?? []), item.env] as unknown as [string, ...string[]];

/** The settings an MCP needs for a kind and lacks: each required field, by the names it reads. */
export function requiredOf(kind: SetupKind): {env: string; names: [string, ...string[]]}[] {
  return kind.fields.filter(item => item.required).map(item => ({env: item.env, names: names(item)}));
}

/** The model a serial number names, by the MCP's own table. */
export function modelForSerial(kind: SetupKind | undefined, serial: string | undefined): string | undefined {
  const model = field(kind, 'model')?.fromSerial;
  return serial && model ? model.models[serial.trim().slice(0, model.prefixLength).toUpperCase()] : undefined;
}

/** A form's values as the MCP's own variables: the kind's fixed values, then each field the form fills. */
export function envOf(kind: SetupKind, values: Partial<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {...kind.env};
  for (const item of kind.fields) {
    const value = values[item.name];
    if (value === undefined || value === '') continue;
    env[item.env] = item.transform === 'uppercase' ? value.toUpperCase() : value;
  }
  return env;
}

/** Add printer…'s choices, as the clients have always read them, from every MCP's own fields. */
export interface SetupOptions {
  types: {printerType: string; label: string; backends: PrinterBackend[]; serial: boolean;
    /** `obtain`: the MCPs that can fetch it (`printers.obtain`), and the button's words, from the first that declares it. */
    secret?: {label: string; hint?: string; required: boolean; obtain?: {label: string; hint?: string; backends: PrinterBackend[]}};
    /** The address field in the first MCP's words: its hint, and `url` when it also takes a web address (`input: "url"`). */
    address?: {hint?: string; url?: true};
    /** The MCPs whose Check asks for this kind's camera picture (each MCP's own `cameraSnapshot`). */
    checkCamera: PrinterBackend[]; fields: SetupField[]}[];
  serialModels: Record<string, string>;
  models: Partial<Record<PrinterBackend, {value: string; label: string}[]>>;
  /** The slicer each MCP would run and the settings that choose it. */
  slicer: Partial<Record<PrinterBackend, SlicerSetup>>;
  /** MCPs on this computer that can't say what they need yet: "Update <MCP> in Settings → Printers". */
  updates: {package: PrinterBackend; message: string}[];
}

/**
 * Every MCP's kinds as one brand list. A kind both MCPs drive lists both, in the given order (the routing rule's
 * preference, PRD §8.2); models and serial tables are per MCP, the first MCP's serial table first.
 */
export function setupOptions(byPackage: {package: PrinterBackend; label: string; setup?: McpSetup; installed: boolean; unanswered?: boolean}[]): SetupOptions {
  const options: SetupOptions = {types: [], serialModels: {}, models: {}, slicer: {}, updates: []};
  for (const {package: pkg, label, setup, installed, unanswered} of byPackage) {
    if (!setup) {
      // An MCP that didn't start or answer in time isn't out of date: it is asked again on the next Find Printers.
      if (installed) options.updates.push({package: pkg, message: unanswered
        ? `${label} didn’t answer in time. Find Printers again in a moment.`
        : `Update ${label} in Settings → Printers so Counterpart can set up printers with it.`});
      continue;
    }
    if (setup.slicer) options.slicer[pkg] = setup.slicer;
    // An MCP that doesn't say whether Check can show a camera is one to update; Check then asks only for the status.
    if (installed && setup.kinds.some(kind => kind.cameraSnapshot === undefined))
      options.updates.push({package: pkg, message: `Update ${label} in Settings → Printers so Check knows whether it can show the printer’s camera.`});
    for (const kind of setup.kinds) {
      const secret = field(kind, 'secret'), model = field(kind, 'model'), host = field(kind, 'host');
      const listed = options.types.find(item => item.printerType === kind.kind);
      if (listed) { if (!listed.backends.includes(pkg)) listed.backends.push(pkg); }
      else options.types.push({printerType: kind.kind, label: kind.label, backends: [pkg], serial: !!field(kind, 'serial'),
        ...(secret ? {secret: {label: secret.label, ...(secret.hint ? {hint: secret.hint} : {}), required: secret.required}} : {}),
        ...(host && (host.hint || host.input === 'url') ? {address: {...(host.hint ? {hint: host.hint} : {}), ...(host.input === 'url' ? {url: true as const} : {})}} : {}),
        checkCamera: [], fields: kind.fields});
      const type = options.types.find(item => item.printerType === kind.kind)!;
      if (kind.cameraSnapshot === true && !type.checkCamera.includes(pkg)) type.checkCamera.push(pkg);
      if (secret?.obtain && type.secret) {
        type.secret.obtain ??= {label: secret.obtain.label, ...(secret.obtain.hint ? {hint: secret.obtain.hint} : {}), backends: []};
        type.secret.obtain.backends.push(pkg);
      }
      if (model?.choices && !options.models[pkg]) options.models[pkg] = model.choices;
      for (const [prefix, value] of Object.entries(model?.fromSerial?.models ?? {})) options.serialModels[prefix] ??= value;
    }
  }
  return options;
}

/**
 * The kind an MCP's `.env` sets up: the kind whose fixed values (its `env`, such as `PRINTER_TYPE`) the file has,
 * the most specific first. An MCP with a single kind and no such value (bambu-printer-mcp) is always that kind. A
 * `.env` that sets none of them is the kind the MCP itself says it runs then (`default`); an MCP that declares
 * none gets no guess.
 */
export function kindFor(setup: McpSetup | undefined, env: Record<string, string | undefined>): SetupKind | undefined {
  const fixed = (kind: SetupKind) => Object.entries(kind.env).filter(([key]) => key !== 'MCP_TRANSPORT');
  const matching = (setup?.kinds ?? []).filter(kind => fixed(kind).every(([key, value]) => env[key]?.trim().toLowerCase() === value.toLowerCase()))
    .sort((a, b) => fixed(b).length - fixed(a).length);
  if (matching[0]) return matching[0];
  const keys = new Set((setup?.kinds ?? []).flatMap(kind => fixed(kind).map(([key]) => key)));
  return [...keys].every(key => !env[key]?.trim()) ? setup?.kinds.find(kind => kind.default) : undefined;
}

/** The MCPs' last answers, kept so the printer list can tell what a printer's `.env` lacks without starting them. */
export const SetupCacheSchema = z.object({version: z.literal(1), setups: z.record(z.string().max(64), McpSetupSchema)});
export async function readSetupCache(path: string): Promise<Map<string, McpSetup>> {
  const {readFile} = await import('node:fs/promises');
  try {
    const parsed = SetupCacheSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return new Map(parsed.success ? Object.entries(parsed.data.setups) : []);
  } catch { return new Map(); }
}
export async function writeSetupCache(path: string, setups: Map<string, McpSetup>): Promise<void> {
  const {mkdir, rename, writeFile} = await import('node:fs/promises');
  const {dirname} = await import('node:path');
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({version: 1, setups: Object.fromEntries(setups)}, null, 1) + '\n', {mode: 0o600});
  await rename(temporary, path);
}
