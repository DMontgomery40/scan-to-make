/** One thing the user scanned or asked to have made, as the Mac keeps it (`/v1/objects`). */
export type ObjectState =
  | 'new'
  | 'touching-up'
  | 'needs-closeup'
  | 'ready'
  | 'printing'
  | 'printed'
  | 'failed';

export interface ObjectPass {
  startedAtMs: number;
  endedAtMs?: number;
  note?: string;
  status?: string;
  summary?: string;
}

export interface StmObject {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  instructions?: string;
  state: ObjectState;
  scan?: string;
  photos: string[];
  passes: ObjectPass[];
  current?: {
    model: string;
    renders: string[];
    sizeMm?: [number, number, number];
    summary?: string;
  };
  question?: { closeup: string };
  plate?: { item?: string; noCamera?: boolean; photo?: boolean };
  failure?: string;
  /** `uncertain`: the printer may already have started it. */
  print?: { bundleId: string; uncertain?: boolean };
}
