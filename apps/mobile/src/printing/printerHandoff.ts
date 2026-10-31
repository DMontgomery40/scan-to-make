import type { ProjectAcknowledgment } from '../screens/scanServices';

/**
 * Hands a cleaned scan to a printer MCP server on the companion computer
 * (services/printer-handoff). The phone picks the backend and says what to
 * make; slicing and printing stay with that server.
 */
export type PrinterBackend = 'bambu-printer-mcp' | 'mcp-3d-printer-server';
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
  | 'failed';
export type Handoff = {
  id: string;
  backend: PrinterBackend;
  status: HandoffStatus;
  failure?: string;
};

export interface PrinterHandoff {
  /** The backends the companion is set up to run, with their defaults. */
  backends(ack: ProjectAcknowledgment): Promise<PrinterOption[]>;
  create(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    request: { prompt: string; backend: PrinterBackend },
  ): Promise<Handoff>;
  status(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    handoffId: string,
  ): Promise<Handoff>;
  /**
   * The handoff a send whose reply was lost may have created: the same
   * request, created no earlier than `since` (allowing for clock skew).
   * Null when the companion has none.
   */
  find(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    request: UncertainSend,
  ): Promise<Handoff | null>;
}

/** A send whose outcome is unknown because its reply never arrived. */
export type UncertainSend = {
  startedAtMs: number;
  prompt: string;
  backend: PrinterBackend;
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
  value === 'bambu-printer-mcp' || value === 'mcp-3d-printer-server';
function recordOf(value: unknown): HandoffRecord | null {
  const v = value as { handoffId?: unknown; uncertain?: Partial<UncertainSend> } | null;
  if (typeof v?.handoffId === 'string') return { handoffId: v.handoffId };
  const u = v?.uncertain;
  return u &&
    typeof u.startedAtMs === 'number' &&
    typeof u.prompt === 'string' &&
    isBackend(u.backend)
    ? { uncertain: { startedAtMs: u.startedAtMs, prompt: u.prompt, backend: u.backend } }
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
  failed: 'This didn’t reach your printer.',
};

export const isFinished = (handoff: Handoff) =>
  handoff.status === 'printed' || handoff.status === 'failed';
