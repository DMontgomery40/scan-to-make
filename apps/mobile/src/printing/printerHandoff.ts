import type { CaptureFile } from '../capture/retainedCaptures';
import type { ProjectAcknowledgment } from '../screens/scanServices';

/**
 * Hands a cleaned scan to a printer MCP server on the companion computer
 * (services/printer-handoff). The phone picks the backend, sends the cleaned
 * model and any request, and answers the printer server's confirmations;
 * slicing and printing stay with that server.
 */
export type PrinterBackend = 'bambu-printer-mcp' | 'mcp-3d-printer-server';
export const PRINTER_BACKENDS: readonly PrinterBackend[] = [
  'bambu-printer-mcp',
  'mcp-3d-printer-server',
];
export type PrinterOption = {
  backend: PrinterBackend;
  /** The operator's defaults, e.g. `{ printerType: 'klipper' }`. */
  selection?: { printerType?: string; model?: string };
};
export type HandoffStatus =
  | 'ready'
  | 'claimed'
  | 'designed'
  | 'sliced'
  | 'printed'
  /**
   * Bambu Connect route (MAC-6): your Mac imported the file into Bambu Connect.
   * Nothing prints until you press Print there. Final; never sent again.
   */
  | 'handed-off'
  /**
   * The printer software has been asked to print. While the companion is
   * still printing that is normal (its questions come now); once it stops
   * without hearing back, the job may have started and is never resent.
   */
  | 'uncertain'
  | 'failed';
export type Handoff = {
  id: string;
  backend: PrinterBackend;
  status: HandoffStatus;
  failure?: string;
  /** The request saved with it; an agent on the computer acts on it. */
  prompt?: string;
  /** The companion is slicing or printing it right now. */
  printing?: boolean;
};

/** A photo the printer server took just before asking, e.g. of the bed. */
export type CameraSnapshot = {
  mediaType: 'image/jpeg' | 'image/png';
  base64: string;
};
/**
 * A printer server's question (an MCP elicitation), relayed by the companion.
 * Nothing prints until the person answers; an unanswered one expires as cancel.
 */
export type Confirmation = {
  id: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: unknown;
  url?: string;
  cameraSnapshot?: CameraSnapshot;
  /** When the companion asked, on its clock. Missing from older companions. */
  createdAtMs?: number;
  /** When the companion stops waiting, on its clock. */
  expiresAtMs: number;
};

/**
 * When a question stops taking answers, on this phone's clock: the time it
 * was first seen here plus how long the companion waits. That is never
 * earlier than the companion's own deadline, whatever the two clocks say.
 * Null when the companion doesn't say when it asked; then only the
 * companion ends the question.
 */
export function confirmationDeadline(confirmation: Confirmation, firstSeenMs: number) {
  return confirmation.createdAtMs === undefined
    ? null
    : firstSeenMs + Math.max(0, confirmation.expiresAtMs - confirmation.createdAtMs);
}
export type ConfirmationValue = string | number | boolean | string[];
export type ConfirmationAnswer =
  | { action: 'accept'; content: Record<string, ConfirmationValue> }
  | { action: 'decline' | 'cancel' };

export interface PrinterHandoff {
  /**
   * The backends the companion is set up to run, with their defaults, or
   * null when the companion doesn't say and uses its own configured one.
   */
  backends(ack: ProjectAcknowledgment): Promise<PrinterOption[] | null>;
  /** The handoffs already on the companion, by id. */
  bundleIds(ack: ProjectAcknowledgment): Promise<string[]>;
  /** Sends the verified cleaned model; `backend` null leaves it to the companion. */
  create(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    request: { prompt: string; backend: PrinterBackend | null; model: CaptureFile },
  ): Promise<Handoff>;
  status(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    handoffId: string,
  ): Promise<Handoff>;
  /**
   * The handoff a send whose reply was lost may have created: the same
   * request, and not one of the handoffs listed before that send began.
   * Null when the companion has none.
   */
  find(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    request: UncertainSend,
  ): Promise<Handoff | null>;
  /** Starts slicing and printing; confirmations follow. */
  print(handoffId: string): Promise<void>;
  /** Stops a running handoff. False when the companion can't stop one. */
  cancel(handoffId: string): Promise<boolean>;
  /** Questions waiting for an answer, newest last. */
  confirmations(): Promise<Confirmation[]>;
  answer(confirmationId: string, answer: ConfirmationAnswer): Promise<void>;
}

/** A send whose outcome is unknown because its reply never arrived. */
export type UncertainSend = {
  startedAtMs: number;
  prompt: string;
  /** Null when the companion picks its own printer software. */
  backend: PrinterBackend | null;
  /** SHA-256 of the model sent. */
  model: string;
  /**
   * The handoffs on the companion just before this send, so an earlier
   * identical send is never mistaken for it. Missing from older records.
   */
  before?: string[];
};
/** What this phone keeps per scan: the job it sent, or a send it can't confirm. */
export type HandoffRecord = { handoffId: string } | { uncertain: UncertainSend };

/**
 * True when a failed send may still have reached the companion: the reply
 * was lost or the companion failed mid-request, rather than refusing it.
 */
export function outcomeUnknown(failure: { status?: number }) {
  return failure.status === undefined || failure.status === 408 || failure.status >= 500;
}

/**
 * The handoff last sent for each scan, so leaving and reopening Send to
 * printer reattaches to that job instead of offering a duplicate send.
 */
export interface HandoffMemory {
  load(projectId: string, captureId: string): Promise<HandoffRecord | null>;
  save(
    projectId: string,
    captureId: string,
    record: HandoffRecord | null,
  ): Promise<void>;
}
const isBackend = (value: unknown): value is PrinterBackend =>
  PRINTER_BACKENDS.includes(value as PrinterBackend);
function recordOf(value: unknown): HandoffRecord | null {
  const v = value as { handoffId?: unknown; uncertain?: Partial<UncertainSend> } | null;
  if (typeof v?.handoffId === 'string') return { handoffId: v.handoffId };
  const u = v?.uncertain;
  return u &&
    typeof u.startedAtMs === 'number' &&
    typeof u.prompt === 'string' &&
    typeof u.model === 'string' &&
    (u.backend === null || isBackend(u.backend))
    ? {
        uncertain: {
          startedAtMs: u.startedAtMs,
          prompt: u.prompt,
          backend: u.backend,
          model: u.model,
          // An unreadable list falls back to matching by time; the lost send
          // itself is never forgotten.
          ...(Array.isArray(u.before) && u.before.every(id => typeof id === 'string')
            ? { before: [...u.before] }
            : {}),
        },
      }
    : null;
}
const memoryKey = (projectId: string, captureId: string) =>
  JSON.stringify(['printer-handoff', 1, projectId, captureId]);

/** Kept for the app session only. Survives navigation, not a relaunch. */
export function sessionHandoffMemory(): HandoffMemory {
  const handoffs = new Map<string, HandoffRecord>();
  return {
    load: async (projectId, captureId) =>
      handoffs.get(memoryKey(projectId, captureId)) ?? null,
    save: async (projectId, captureId, record) => {
      if (record) handoffs.set(memoryKey(projectId, captureId), record);
      else handoffs.delete(memoryKey(projectId, captureId));
    },
  };
}

/**
 * Kept on this device across relaunches, in the app's private key-value
 * store, behind a session copy: if saving to the device fails, leaving and
 * reopening the screen in this session still finds the job.
 */
export function storedHandoffMemory(native: {
  read(key: string): Promise<string | null>;
  write(key: string, body: string): Promise<void>;
}): HandoffMemory {
  // What this session saved, including null for an explicit clear, so a
  // failed device write can neither lose a job nor bring a cleared one back.
  const session = new Map<string, HandoffRecord | null>();
  return {
    async load(projectId, captureId) {
      const key = memoryKey(projectId, captureId);
      if (session.has(key)) return session.get(key) ?? null;
      const body = await native.read(key);
      if (!body) return null;
      try {
        return recordOf(JSON.parse(body));
      } catch {
        return null;
      }
    },
    async save(projectId, captureId, record) {
      const key = memoryKey(projectId, captureId);
      session.set(key, record);
      await native.write(key, JSON.stringify(record ?? {}));
    },
  };
}

/**
 * The printer software the person chose once (KAN-125). It is sent with each
 * handoff and offered again only when the companion can't run it.
 */
export interface PrinterChoiceMemory {
  load(): Promise<PrinterBackend | null>;
  save(backend: PrinterBackend): Promise<void>;
}
const CHOICE_KEY = JSON.stringify(['printer-choice', 1]);

export function sessionPrinterChoice(): PrinterChoiceMemory {
  let chosen: PrinterBackend | null = null;
  return {
    load: async () => chosen,
    save: async backend => {
      chosen = backend;
    },
  };
}

export function storedPrinterChoice(native: {
  read(key: string): Promise<string | null>;
  write(key: string, body: string): Promise<void>;
}): PrinterChoiceMemory {
  return {
    async load() {
      const body = await native.read(CHOICE_KEY);
      try {
        const backend = body ? JSON.parse(body)?.backend : null;
        return isBackend(backend) ? backend : null;
      } catch {
        return null;
      }
    },
    save: backend => native.write(CHOICE_KEY, JSON.stringify({ backend })),
  };
}

export const BACKEND_NAMES: Record<
  PrinterBackend,
  { title: string; detail: string }
> = {
  'bambu-printer-mcp': {
    title: 'Bambu Lab printer',
    detail: 'Through bambu-printer-mcp',
  },
  'mcp-3d-printer-server': {
    title: 'Other 3D printers',
    detail:
      'Through mcp-3D-printer-server: OctoPrint, Klipper, Duet, Repetier, Prusa, Creality and Bambu',
  },
};

export const STATUS_TEXT: Record<HandoffStatus, string> = {
  ready: 'Waiting for the agent on your computer to pick it up.',
  claimed: 'The agent on your computer is working on it.',
  designed: 'The design is ready. Slicing comes next.',
  sliced: 'Sliced and ready for your printer.',
  printed: 'Sent to your printer.',
  'handed-off': 'Finish on your Mac: press Print in Bambu Connect.',
  uncertain: 'This may already be printing. Check your printer.',
  failed: 'This didn’t reach your printer.',
};

/**
 * Nothing more will happen here: printed, in Bambu Connect, failed, or
 * uncertain once the companion stopped printing.
 */
export const isFinished = (handoff: Handoff) =>
  handoff.status === 'printed' ||
  handoff.status === 'handed-off' ||
  handoff.status === 'failed' ||
  (handoff.status === 'uncertain' && handoff.printing === false);
