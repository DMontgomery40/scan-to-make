/** A print can't start while its printer's MCP is being updated. */
export class PrinterUpdatingError extends Error {
  constructor() { super("The printer's software is updating. Try again in a minute."); this.name = 'PrinterUpdatingError'; }
}

/**
 * PRD §8.10: one admission point for prints and MCP updates on a printer. A print holds its printer from
 * admission until its dispatch ends (the project's `printing` state covers the monitored part after that);
 * an update marks its printers before it checks for prints, so neither can slip in under the other.
 */
export class PrintGate {
  readonly #holds = new Map<string, number>();
  readonly #updating = new Set<string>();

  /** A print is starting on this printer. Throws when an update is running there. */
  hold(destinationId: string): () => void {
    if (this.#updating.has(destinationId)) throw new PrinterUpdatingError();
    this.#holds.set(destinationId, (this.#holds.get(destinationId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#holds.get(destinationId) ?? 1) - 1;
      if (left > 0) this.#holds.set(destinationId, left); else this.#holds.delete(destinationId);
    };
  }
  held(destinationId: string): boolean { return (this.#holds.get(destinationId) ?? 0) > 0; }
  updating(destinationId: string): boolean { return this.#updating.has(destinationId); }

  /** Marks these printers as updating, unless a print holds one of them now. */
  beginUpdate(destinationIds: string[]): boolean {
    if (destinationIds.some(id => this.held(id) || this.#updating.has(id))) return false;
    for (const id of destinationIds) this.#updating.add(id);
    return true;
  }
  endUpdate(destinationIds: string[]): void { for (const id of destinationIds) this.#updating.delete(id); }
}
