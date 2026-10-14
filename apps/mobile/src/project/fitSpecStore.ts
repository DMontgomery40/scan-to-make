import {
  applyFitSpecPatch,
  validateFitSpec,
  type FitSpec,
  type FitSpecPatch,
} from '@scan-to-make/contracts';

/** Legacy isolated fit-store interface used by unit tests.
 * Consumer persistence uses the saved-project repository in savedProjects.ts.
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

/** In-memory fixture store; never used as the consumer persistence fallback. */
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
