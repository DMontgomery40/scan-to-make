import {
  detectCapabilities, readPrinterInfo, readPrintReport, readiness,
  type PrinterCapabilities, type PrinterSession, type PrinterToolCatalog, type PrintReport,
} from '@scan-to-make/printer-handoff';
import type {PrinterCatalog, PrinterDestination} from '../objects/printers.js';

export type Readiness = ReturnType<typeof readiness>;
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
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
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

  /** Call from the session's onConnect: reads `counterpart_printer_info` when present, then records capabilities. */
  connected(destinationId: string, catalog: PrinterToolCatalog): void {
    const session = this.#session(destinationId);
    if (!session) return;
    this.#capabilities.set(destinationId, detectCapabilities(session.config, catalog));
    void readPrinterInfo(session, {failFast: true}).then(info => {
      if (info) this.#capabilities.set(destinationId, detectCapabilities(session.config, catalog, info));
    }).catch(() => undefined);
  }

  /** Any report for the destination (the monitor's, a list refresh) updates its readiness. */
  record(destinationId: string, report: PrintReport | undefined, failed = false): void {
    const id = this.catalog.canonical(destinationId) ?? destinationId;
    this.#reports.set(id, {...(report ? {report} : {}), state: failed ? 'offline' : readiness(report), checkedAt: this.#now()});
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
    const work = readPrintReport(session, {failFast: true, signal: AbortSignal.timeout(20_000)})
      .then(report => this.record(id, report), () => this.record(id, undefined, true))
      .finally(() => this.#refreshing.delete(id));
    this.#refreshing.set(id, work);
    return work;
  }

  /** The list the phone and Mac show; starts background reads, never waits for them. */
  list(): {defaultDestinationId: string; destinations: PublicDestination[]} {
    return {defaultDestinationId: this.catalog.defaultDestinationId, destinations: this.catalog.destinations.map(destination => {
      void this.refresh(destination.id);
      const known = this.#reports.get(destination.id), capabilities = this.#capabilities.get(destination.id);
      const mcpId = this.#versions?.mcpId(destination.id);
      return {...destination, state: known?.state ?? 'unknown',
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
