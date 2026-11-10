/** A printer MCP operation cannot start while its install is being updated. */
export class PrinterUpdatingError extends Error {
  constructor() { super("The printer's software is updating. Try again in a minute."); this.name = 'PrinterUpdatingError'; }
}

/**
 * PRD §8.10: one admission point for prints, design/cleanup passes, and MCP updates. A print holds its printer from
 * admission until its dispatch ends (the project's `printing` state covers the monitored part after that);
 * design passes hold `current` through queued work and helper cleanup. An update marks every printer
 * sharing its install before checking for prints, so neither kind of work can slip in under it.
 */
export class PrintGate {
  readonly #holds = new Map<string, number>();
  readonly #updating = new Set<string>();

  /** MCP work is starting for this destination. Throws when its install is updating. */
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
  /** Any MCP work admitted anywhere (a send, a slice, a design pass, an answer), or any printer marked as updating. */
  busy(): boolean { return this.#holds.size > 0 || this.#updating.size > 0; }

  /** Marks these printers as updating, unless admitted MCP work holds one now. */
  beginUpdate(destinationIds: string[]): boolean {
    if (destinationIds.some(id => this.held(id) || this.#updating.has(id))) return false;
    for (const id of destinationIds) this.#updating.add(id);
    return true;
  }
  endUpdate(destinationIds: string[]): void { for (const id of destinationIds) this.#updating.delete(id); }
}
