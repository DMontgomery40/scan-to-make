import type {
  Confirmation,
  Handoff,
  PrinterHandoff,
  PrinterOption,
} from '../../printing/printerHandoff';

export const HANDOFF_ID = 'h1';

// The hardware confirmation both bambu-printer-mcp and mcp-3D-printer-server send.
export const HARDWARE_CONFIRMATION = {
  type: 'object',
  properties: {
    confirmed: {
      type: 'boolean',
      title: 'I checked the printer and confirm this operation',
      default: false,
    },
  },
  required: ['confirmed'],
};
// Their printer-model question.
export const MODEL_QUESTION = {
  type: 'object',
  properties: {
    bambu_model: {
      type: 'string',
      title: 'Printer Model',
      description: 'Which Bambu Lab printer do you have?',
      oneOf: [
        { const: 'p1s', title: 'P1S' },
        { const: 'x1c', title: 'X1 Carbon' },
      ],
    },
  },
  required: ['bambu_model'],
};

/** A pending hardware confirmation, ten minutes from expiry by default. */
export function syntheticConfirmation(overrides: Partial<Confirmation> = {}): Confirmation {
  return {
    id: 'q1',
    mode: 'form',
    message: 'Check that the bed is clear, then confirm the print.',
    requestedSchema: HARDWARE_CONFIRMATION,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 10 * 60000,
    ...overrides,
  };
}

/**
 * A scripted printer handoff. Each status check takes the next entry of
 * `statuses` (an Error makes that check fail) and each confirmations check
 * the next list; when a script runs out the last state holds.
 */
export function fakePrinting(
  options: {
    backends?: PrinterOption[] | null;
    statuses?: (Partial<Handoff> | Error)[];
    confirmations?: Confirmation[][];
    /** What cancel answers: true when the companion stopped the job. */
    cancel?: boolean;
    /** What looking for a send with a lost reply finds, or an Error. */
    found?: Handoff | null | Error;
    /** The handoffs already on the companion. */
    bundleIds?: string[];
  } = {},
) {
  const calls: string[] = [];
  const statuses = [...(options.statuses ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  let current: Handoff | null = null;
  const client: PrinterHandoff = {
    backends: async () => {
      calls.push('backends');
      return options.backends === undefined ? [{ backend: 'bambu-printer-mcp' }] : options.backends;
    },
    bundleIds: async () => {
      calls.push('bundles');
      return options.bundleIds ?? [];
    },
    create: async (_p, _c, _a, request) => {
      calls.push(`create ${request.backend ?? 'companion'} "${request.prompt}" ${request.model.mediaType}`);
      current = {
        id: HANDOFF_ID,
        backend: request.backend ?? 'bambu-printer-mcp',
        status: 'ready',
        ...(request.prompt ? { prompt: request.prompt } : {}),
      };
      return current;
    },
    status: async (_p, _c, _a, id) => {
      calls.push(`status ${id}`);
      const next = statuses.shift();
      if (next instanceof Error) throw next;
      current = {
        ...(current ?? { id, backend: 'bambu-printer-mcp', status: 'ready' }),
        id,
        ...next,
      };
      return current;
    },
    find: async (_p, _c, _a, request) => {
      calls.push(`find "${request.prompt}" ${request.backend ?? 'companion'}`);
      const found = options.found ?? null;
      if (found instanceof Error) throw found;
      if (found) current = found;
      return found;
    },
    print: async id => {
      calls.push(`print ${id}`);
    },
    cancel: async id => {
      calls.push(`cancel ${id}`);
      return options.cancel ?? true;
    },
    confirmations: async () => {
      calls.push('confirmations');
      return confirmations.length > 1 ? confirmations.shift()! : confirmations[0] ?? [];
    },
    answer: async (id, answer) => {
      calls.push(`answer ${id} ${JSON.stringify(answer)}`);
    },
  };
  return { client, calls };
}
