import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ElicitRequest, ElicitResult} from '@modelcontextprotocol/sdk/types.js';

export type ElicitationContentValue = string | number | boolean | string[];
export type ElicitationAnswer =
  | {action: 'accept'; content: Record<string, ElicitationContentValue>}
  | {action: 'decline' | 'cancel'; content?: undefined};

export interface CameraSnapshotContext {
  format: string;
  base64: string;
  savedTo?: string;
}

export interface PendingElicitation {
  id: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
  cameraSnapshot?: CameraSnapshotContext;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ElicitationContext {
  cameraSnapshot?: CameraSnapshotContext;
}

export interface ElicitationRelay {
  request(request: ElicitRequest, context?: ElicitationContext): Promise<ElicitResult>;
  pending(): PendingElicitation[];
  respond(id: string, answer: ElicitationAnswer): boolean;
  subscribe(listener: (pending: PendingElicitation) => void): () => void;
  cancelAll(): void;
}

const answerSchema = z.union([
  z.strictObject({
    action: z.literal('accept'),
    content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  }),
  z.strictObject({action: z.literal(['decline', 'cancel'])}),
]);

interface PendingEntry {
  snapshot: PendingElicitation;
  resolve: (result: ElicitResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * In-memory relay between an MCP server's elicitation request and whichever
 * surface the user answers on (the phone, in KAN-132). It never answers on
 * the user's behalf: a timeout resolves as `cancel`.
 */
export class InMemoryElicitationRelay implements ElicitationRelay {
  readonly #timeoutMs: number;
  readonly #onPending?: (pending: PendingElicitation) => void;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #listeners = new Set<(pending: PendingElicitation) => void>();

  constructor(options: {timeoutMs?: number; onPending?: (pending: PendingElicitation) => void} = {}) {
    this.#timeoutMs = options.timeoutMs ?? 600000;
    this.#onPending = options.onPending;
  }

  request(request: ElicitRequest, context: ElicitationContext = {}): Promise<ElicitResult> {
    const now = Date.now();
    const params = request.params as {
      mode?: string; message: string; requestedSchema?: unknown; url?: string; elicitationId?: string;
    };
    const snapshot: PendingElicitation = {
      id: randomUUID(),
      mode: params.mode === 'url' ? 'url' : 'form',
      message: String(params.message ?? ''),
      ...(params.requestedSchema === undefined ? {} : {requestedSchema: structuredClone(params.requestedSchema)}),
      ...(params.url === undefined ? {} : {url: params.url}),
      ...(params.elicitationId === undefined ? {} : {elicitationId: params.elicitationId}),
      ...(context.cameraSnapshot === undefined ? {} : {cameraSnapshot: context.cameraSnapshot}),
      createdAtMs: now,
      expiresAtMs: now + this.#timeoutMs,
    };
    return new Promise(resolve => {
      // Ref'd on purpose: a pending confirmation must keep the process alive
      // until it is answered or expires. Cleared in respond()/cancelAll().
      const timer = setTimeout(() => {
        this.#pending.delete(snapshot.id);
        resolve({action: 'cancel'});
      }, this.#timeoutMs);
      this.#pending.set(snapshot.id, {snapshot, resolve, timer});
      this.#onPending?.(structuredClone(snapshot));
      for (const listener of this.#listeners) listener(structuredClone(snapshot));
    });
  }

  pending(): PendingElicitation[] {
    return [...this.#pending.values()].map(entry => structuredClone(entry.snapshot));
  }

  respond(id: string, answer: ElicitationAnswer): boolean {
    const checked = answerSchema.parse(answer);
    const entry = this.#pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    entry.resolve(checked.action === 'accept' ? {action: 'accept', content: checked.content} : {action: checked.action});
    return true;
  }

  subscribe(listener: (pending: PendingElicitation) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  cancelAll(): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({action: 'cancel'});
    }
    this.#pending.clear();
  }
}
