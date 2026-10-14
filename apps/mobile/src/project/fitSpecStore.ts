import {
  applyFitSpecPatch,
  validateFitSpec,
  type FitSpec,
  type FitSpecPatch,
} from '@scan-to-make/contracts';

/**
 * The app's only path for changing a FitSpec. Every edit is a contract
 * `FitSpecPatch` carrying `expectedRevision`, and stores must reject stale
 * revisions. The in-memory store stands in for the CORE-002 project service
 * (services/project), which is expected to implement this same interface.
 */
export interface FitSpecStore {
  create(spec: FitSpec): Promise<FitSpec>;
  get(id: string): Promise<FitSpec | null>;
  applyPatch(id: string, patch: FitSpecPatch): Promise<FitSpec>;
}

export class StaleRevisionError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Stale FitSpec revision: expected ${expectedRevision}, current ${currentRevision}`,
    );
    this.name = 'StaleRevisionError';
  }
}

/** Not persisted; relaunch recovery arrives with the CORE-002 service. */
export function memoryFitSpecStore(): FitSpecStore {
  const specs = new Map<string, FitSpec>();
  return {
    async create(spec) {
      const validated = validateFitSpec(spec);
      if (specs.has(validated.id)) {
        throw new Error(`FitSpec ${validated.id} already exists`);
      }
      specs.set(validated.id, validated);
      return validateFitSpec(validated);
    },
    async get(id) {
      const spec = specs.get(id);
      return spec ? validateFitSpec(spec) : null;
    },
    async applyPatch(id, patch) {
      const current = specs.get(id);
      if (!current) {
        throw new Error(`Unknown FitSpec ${id}`);
      }
      if (patch.expectedRevision !== current.revision) {
        throw new StaleRevisionError(patch.expectedRevision, current.revision);
      }
      const next = applyFitSpecPatch(current, patch);
      specs.set(id, next);
      return validateFitSpec(next);
    },
  };
}
