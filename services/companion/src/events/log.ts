import {mkdir, open, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {CounterpartEventSchema, type CounterpartEvent, type EventsPage} from '@scan-to-make/contracts/counterpart';
import type {EventDraft} from '../printing/monitor.js';
import {eventWords, type WordsContext} from './words.js';

export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_WAIT_MS = 25_000;
export const MAX_PAGE = 500;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_EVENTS_IN_MEMORY = 100_000;

/**
 * The append-only event log (PRD §8.7): `<data root>/events.ndjson`, one event
 * per line with a monotonic `seq`, kept 7 days. The highest seq is also kept in
 * `events.meta.json` so numbering continues after pruning or an empty log.
 * Readers page with `after` and may wait for the next event (a long poll).
 */
export class EventLog {
  readonly #path: string;
  readonly #metaPath: string;
  readonly #now: () => number;
  readonly #context: (draft: EventDraft) => Promise<WordsContext>;
  #events: CounterpartEvent[] = [];
  #lastSeq = 0;
  #writing: Promise<unknown> = Promise.resolve();
  readonly #waiters = new Set<() => void>();
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;
  /** Older events were dropped from memory but are still on disk: the next prune rewrites the file. */
  #compactPending = false;

  constructor(path: string, options: {context: (draft: EventDraft) => Promise<WordsContext>; now?: () => number}) {
    this.#path = path;
    this.#metaPath = join(dirname(path), 'events.meta.json');
    this.#now = options.now ?? Date.now;
    this.#context = options.context;
  }

  get latest(): number { return this.#lastSeq; }
  get waiting(): number { return this.#waiters.size; }

  /** Loads the retained events, prunes, and starts the hourly prune. */
  async open(options: {prune?: boolean} = {}): Promise<this> {
    await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
    try {
      const meta = JSON.parse(await readFile(this.#metaPath, 'utf8')) as {lastSeq?: unknown};
      if (typeof meta.lastSeq === 'number' && Number.isSafeInteger(meta.lastSeq) && meta.lastSeq > 0) this.#lastSeq = meta.lastSeq;
    } catch { /* no meta yet */ }
    let text = '';
    try { text = await readFile(this.#path, 'utf8'); } catch { /* no log yet */ }
    let damaged = text.length > 0 && !text.endsWith('\n');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = CounterpartEventSchema.parse(JSON.parse(line));
        // A torn or reordered line never moves seq backwards.
        if (event.seq > (this.#events.at(-1)?.seq ?? 0)) this.#events.push(event); else damaged = true;
      } catch { damaged = true; /* a damaged line is skipped */ }
    }
    this.#lastSeq = Math.max(this.#lastSeq, this.#events.at(-1)?.seq ?? 0);
    // A crash can leave a half-written last line: rewrite the file before anything is appended after it.
    if (damaged) await this.#rewrite(this.#events);
    await this.prune();
    if (options.prune !== false) { this.#timer = setInterval(() => void this.prune().catch(() => undefined), PRUNE_EVERY_MS); this.#timer.unref(); }
    return this;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const wake of this.#waiters) wake();
  }

  /** Drops events older than 7 days, rewriting the file atomically. Runs in the write queue, after any append in flight. */
  async prune(): Promise<void> {
    await (this.#writing = this.#writing.catch(() => undefined).then(async () => {
      const cutoff = this.#now() - EVENT_RETENTION_MS;
      const keep = this.#events.filter(event => Date.parse(event.at) >= cutoff).slice(-MAX_EVENTS_IN_MEMORY);
      await this.#writeMeta();
      if (keep.length === this.#events.length && !this.#compactPending) return;
      await this.#rewriteNow(keep);
      this.#compactPending = false;
    }));
  }

  async #rewrite(events: CounterpartEvent[]) {
    await (this.#writing = this.#writing.catch(() => undefined).then(() => this.#rewriteNow(events)));
  }
  async #rewriteNow(events: CounterpartEvent[]) {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, events.map(event => JSON.stringify(event) + '\n').join(''), {mode: 0o600});
    await rename(temporary, this.#path);
    this.#events = events;
    await this.#writeMeta();
  }

  async #writeMeta() {
    const temporary = `${this.#metaPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({lastSeq: this.#lastSeq}) + '\n', {mode: 0o600});
    await rename(temporary, this.#metaPath);
  }

  /** Adds the words and a seq, writes the line, and wakes every waiting reader. */
  async append(draft: EventDraft): Promise<CounterpartEvent> {
    const context = await this.#context(draft).catch((): WordsContext => ({title: 'Your project'}));
    const words = eventWords(draft.type, draft.data, {...context, ...(draft.printerName ? {printer: draft.printerName} : {}),
      ...(draft.detail?.item ? {item: draft.detail.item} : {}), ...(draft.detail?.question ? {question: draft.detail.question} : {}),
      ...(draft.detail?.size ? {size: draft.detail.size} : {}), ...(draft.detail?.printedBefore ? {printedBefore: true} : {}), ...(draft.detail?.reason ? {reason: draft.detail.reason} : {}),
      // A deleted project can't be read back, so its event carries the title it had.
      ...(draft.detail?.title ? {title: draft.detail.title} : {}),
      ...(draft.type === 'print.sent' && draft.detail?.message === 'bambu-connect' ? {reason: 'bambu-connect'} : {}),
      ...(draft.detail?.package ? {package: draft.detail.package} : {})});
    const written = this.#writing.catch(() => undefined).then(async () => {
      const event = CounterpartEventSchema.parse({v: 1, seq: this.#lastSeq + 1, id: draft.id, at: new Date(this.#now()).toISOString(), type: draft.type,
        ...(draft.projectId ? {projectId: draft.projectId} : {}), ...(draft.printId ? {printId: draft.printId} : {}), ...(draft.destinationId ? {destinationId: draft.destinationId} : {}),
        ...(draft.printerName ? {printerName: draft.printerName.slice(0, 120)} : {}), ...words, ...(draft.notify !== undefined ? {notify: draft.notify} : {}),
        ...(draft.data && Object.keys(draft.data).length ? {data: draft.data} : {}), ...(draft.frame ? {frame: draft.frame} : {})});
      const handle = await open(this.#path, 'a', 0o600);
      try { await handle.appendFile(JSON.stringify(event) + '\n'); } finally { await handle.close(); }
      this.#lastSeq = event.seq;
      this.#events.push(event);
      if (this.#events.length > MAX_EVENTS_IN_MEMORY) { this.#events.splice(0, this.#events.length - MAX_EVENTS_IN_MEMORY); this.#compactPending = true; }
      await this.#writeMeta();
      return event;
    });
    this.#writing = written;
    const event = await written;
    for (const wake of [...this.#waiters]) wake();
    return event;
  }

  /** One page after `after` (EventsPage semantics in docs/protocols/events.md). */
  page(after: number, limit = 100): EventsPage {
    const latest = this.#lastSeq;
    if (after > latest) return {events: [], next: latest, latest, reset: true};
    if (limit <= 0) return {events: [], next: latest, latest};
    const size = Math.min(limit, MAX_PAGE);
    // With nothing retained, everything up to latest was pruned.
    const oldest = this.#events[0]?.seq ?? latest + 1;
    const truncated = after < oldest - 1 ? true : undefined;
    const events = this.#events.filter(event => event.seq > after).slice(0, size);
    return {events: structuredClone(events), next: events.at(-1)?.seq ?? after, latest, ...(truncated ? {truncated} : {})};
  }

  /** Like page(), but holds up to `waitMs` (≤ 25 s) for the first event after `after`. */
  async wait(after: number, options: {waitMs?: number; limit?: number; signal?: AbortSignal} = {}): Promise<EventsPage> {
    const first = this.page(after, options.limit);
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), MAX_WAIT_MS);
    if (first.events.length || first.reset || waitMs === 0 || options.limit === 0 || this.#closed || options.signal?.aborted) return first;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); options.signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, waitMs);
      this.#waiters.add(done);
      options.signal?.addEventListener('abort', done, {once: true});
    });
    return this.page(after, options.limit);
  }
}

