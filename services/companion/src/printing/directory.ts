import {
  detectCapabilities, readPrinterInfo, readPrintReport, readiness,
  type PrinterCapabilities, type PrinterSession, type PrinterToolCatalog, type PrintReport,
} from '@scan-to-make/printer-handoff';
import {defaultName, type PrinterCatalog, type PrinterDestination} from '../objects/printers.js';

export type Readiness = ReturnType<typeof readiness>;
/** Names older builds generated for a printer nobody named; a saved profile may still carry one (review F6). */
const LEGACY_GENERATED_NAMES = new Set(['Bambu printer', 'Configured printer']);
export interface PublicDestination extends PrinterDestination {
  state?: Readiness;
  stateCheckedAt?: string;
  capabilities?: PrinterCapabilities;
  mcpId?: string;
}

/** PRD §8.10: which install a destination runs, and the newest published version (McpUpdater). */
export interface McpVersions {
  mcpId(destinationId: string): string | undefined;
  latestVersion(pkg: string, options?: {view?: boolean}): string | undefined;
}
const PACKAGE_LABELS: Record<string, string> = {'bambu-printer-mcp': 'bambu-printer-mcp', 'mcp-3d-printer-server': 'mcp-3D-printer-server'};
/** Whether version a is newer than b (major.minor.patch). */
export function newerVersion(a: string, b: string): boolean {
  // Semantic versions: major.minor.patch, then a release beats its prereleases (1.2.0 > 1.2.0-dev).
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('+')[0]!.split(/-(.*)/s);
    return {core: core.split('.').slice(0, 3).map(n => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : []};
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const [m, n] = [Number(p), Number(q)];
    if (Number.isInteger(m) && Number.isInteger(n)) return m > n;
    if (Number.isInteger(m) !== Number.isInteger(n)) return !Number.isInteger(m);
    return p > q;
  }
  return false;
}

/** How often a list request may start a background read of one destination. */
export const READINESS_REFRESH_MS = 30_000;

/**
 * What the companion knows about each configured destination: its long-lived
 * session (PRD §8.3), the capabilities its MCP showed when it connected, and
 * its last reported state. Nothing here starts a print.
 */
export class PrinterDirectory {
  readonly catalog: PrinterCatalog;
  readonly #session: (destinationId: string) => PrinterSession | undefined;
  readonly #capabilities = new Map<string, PrinterCapabilities>();
  /** The model each printer's MCP reported in `counterpart_printer_info`. */
  readonly #models = new Map<string, string>();
  /** The tool list each destination's session connected with, for reading its printer info again. */
  readonly #catalogs = new Map<string, PrinterToolCatalog>();
  readonly #reports = new Map<string, {report?: PrintReport; state: Readiness; checkedAt: number}>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #now: () => number;
  #versions?: McpVersions;

  constructor(catalog: PrinterCatalog, session: (destinationId: string) => PrinterSession | undefined, options: {now?: () => number} = {}) {
    this.catalog = catalog;
    this.#session = session;
    this.#now = options.now ?? Date.now;
  }

  /** Set once the updater exists: adds `mcpId` and `update.latestVersion` to the list. */
  useVersions(versions: McpVersions): void { this.#versions = versions; }

  /** The session of the destination an id stands for (a duplicate's winner). */
  session(destinationId: string): PrinterSession | undefined {
    const id = this.catalog.canonical(destinationId);
    return id ? this.#session(id) : undefined;
  }
  capabilities(destinationId: string): PrinterCapabilities | undefined {
    const id = this.catalog.canonical(destinationId);
    return id ? this.#capabilities.get(id) : undefined;
  }
  lastReport(destinationId: string): PrintReport | undefined {
    const id = this.catalog.canonical(destinationId);
    return id ? this.#reports.get(id)?.report : undefined;
  }
  /** The readiness last read (ready, busy, offline, unknown), without asking the printer again. */
  lastState(destinationId: string): string | undefined {
    const id = this.catalog.canonical(destinationId);
    return id ? this.#reports.get(id)?.state : undefined;
  }

  /** Call from the session's onConnect: reads `counterpart_printer_info` when present, then records capabilities. */
  connected(destinationId: string, catalog: PrinterToolCatalog): void {
    const session = this.#session(destinationId);
    if (!session) return;
    this.#catalogs.set(destinationId, catalog);
    this.#capabilities.set(destinationId, detectCapabilities(session.config, catalog));
    void this.#readInfo(destinationId, session, catalog);
  }

  /**
   * Capabilities come only from `counterpart_printer_info` (PRD §8.0 item 4), so a read that failed (a timeout, the
   * printer briefly away) is tried again at the next refresh instead of leaving the printer without them.
   */
  async #readInfo(destinationId: string, session: PrinterSession, catalog: PrinterToolCatalog): Promise<void> {
    const info = await readPrinterInfo(session, {failFast: true}).catch(() => undefined);
    if (info && this.#catalogs.get(destinationId) === catalog) {
      this.#capabilities.set(destinationId, detectCapabilities(session.config, catalog, info));
      if (info.printer.model) this.#models.set(destinationId, info.printer.model);
    }
  }

  /**
   * A printer nobody named is shown by the model its MCP reports, not "Printer at 192.0.2.1" (first look U9). A name the
   * person gave, or one already made from a known model, stays.
   */
  #named(destination: PrinterDestination): Pick<PrinterDestination, 'name'> {
    const reported = this.#models.get(destination.id);
    const unnamed = destination.name === defaultName(destination.backend, undefined, destination.address)
      || LEGACY_GENERATED_NAMES.has(destination.name);
    if (!reported || destination.model || !unnamed) return {name: destination.name};
    // The MCP's own display name, exactly as it says it ("A1 Mini", "H2D Pro"): no brand added, nothing reformatted, no
    // branching on which MCP it is (AGENTS.md, "The app staples onto the MCPs"). A brand in the name is the MCPs' to add.
    return {name: reported};
  }

  /** Any report for the destination (the monitor's, a list refresh) updates its readiness. */
  record(destinationId: string, report: PrintReport | undefined, failed = false): void {
    const id = this.catalog.canonical(destinationId) ?? destinationId;
    this.#reports.set(id, {...(report ? {report} : {}), state: failed ? 'offline' : readiness(report), checkedAt: this.#now()});
  }

  /**
   * PRD §8.10: the printer itself says a print is running: any print, the phone's handoff or one started
   * elsewhere, which Counterpart has no project for. Read now, not from the cache. A printer that can't be read
   * isn't printing (and its MCP may be what needs the update).
   */
  async printing(destinationId: string): Promise<boolean> {
    const id = this.catalog.canonical(destinationId);
    const session = id ? this.#session(id) : undefined;
    if (!id || !session) return false;
    const report = await readPrintReport(session, {failFast: true, signal: AbortSignal.timeout(20_000)}).catch(() => undefined);
    this.record(id, report, !report);
    return readiness(report) === 'busy';
  }

  /** Reads the destination's state in the background, at most once per READINESS_REFRESH_MS. */
  refresh(destinationId: string): Promise<void> {
    const id = this.catalog.canonical(destinationId);
    const session = id ? this.#session(id) : undefined;
    if (!id || !session) return Promise.resolve();
    const last = this.#reports.get(id);
    if (last && this.#now() - last.checkedAt < READINESS_REFRESH_MS) return Promise.resolve();
    const running = this.#refreshing.get(id);
    if (running) return running;
    const catalog = this.#catalogs.get(id);
    const retryInfo = catalog && !this.#capabilities.get(id)?.contract && catalog.tools.some(tool => tool.name === 'counterpart_printer_info');
    const work = Promise.all([
      readPrintReport(session, {failFast: true, signal: AbortSignal.timeout(20_000)})
        .then(report => this.record(id, report), () => this.record(id, undefined, true)),
      ...(retryInfo ? [this.#readInfo(id, session, catalog)] : []),
    ]).then(() => undefined).finally(() => this.#refreshing.delete(id));
    this.#refreshing.set(id, work);
    return work;
  }

  /** The list the phone and Mac show; starts background reads, never waits for them. */
  list(): {defaultDestinationId: string; destinations: PublicDestination[]} {
    return {defaultDestinationId: this.catalog.defaultDestinationId, destinations: this.catalog.destinations.map(destination => {
      void this.refresh(destination.id);
      const known = this.#reports.get(destination.id), capabilities = this.#capabilities.get(destination.id);
      const mcpId = this.#versions?.mcpId(destination.id);
      return {...destination, ...this.#named(destination), state: known?.state ?? 'unknown',
        ...(known ? {stateCheckedAt: new Date(known.checkedAt).toISOString()} : {}),
        ...(capabilities ? {capabilities: this.#withLatest(structuredClone(capabilities), destination.backend)} : {}),
        ...(mcpId ? {mcpId} : {})};
    })};
  }

  /** A newer published version shows as `update`, with `latestVersion`, even when no feature is missing. */
  #withLatest(capabilities: PrinterCapabilities, backend: string): PrinterCapabilities {
    const latest = this.#versions?.latestVersion(backend, {view: true});
    if (!latest) return capabilities;
    const newer = newerVersion(latest, capabilities.server.version);
    if (capabilities.update) return {...capabilities, update: {...capabilities.update, latestVersion: latest}};
    if (!newer) return capabilities;
    return {...capabilities, update: {message: `Update ${PACKAGE_LABELS[backend] ?? backend} to ${latest}.`, package: backend as 'bambu-printer-mcp', latestVersion: latest}};
  }
}
