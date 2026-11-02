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

  constructor(catalog: PrinterCatalog, session: (destinationId: string) => PrinterSession | undefined, options: {now?: () => number} = {}) {
    this.catalog = catalog;
    this.#session = session;
    this.#now = options.now ?? Date.now;
  }

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
      return {...destination, state: known?.state ?? 'unknown',
        ...(known ? {stateCheckedAt: new Date(known.checkedAt).toISOString()} : {}),
        ...(capabilities ? {capabilities: structuredClone(capabilities)} : {})};
    })};
  }
}
