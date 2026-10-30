import { z } from 'zod';

export const DETAIL_STILL_SCHEMA_ID = 'scan-to-make.detail-still/0.1';
export const MAX_DETAIL_STILL_BYTES = 25 * 1024 * 1024;
export const MAX_DETAIL_STILLS_PER_CAPTURE = 24;

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * One close-up photo attached to an existing retained capture.
 * The record identifies exact bytes; it carries no region, mask or taxonomy.
 * What the photo shows is for a later model step, beyond the optional label.
 * A digest declaration does not prove bytes match it: consumers hash exact bytes.
 */
export const DetailStillSchema = z.strictObject({
  schema: z.literal(DETAIL_STILL_SCHEMA_ID),
  id: z.uuid(),
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  captureId: z.uuid(),
  projectRevision: revision,
  mediaType: z.enum(['image/jpeg', 'image/heic', 'image/png']),
  byteLength: z.number().int().positive().max(MAX_DETAIL_STILL_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // The user's own words, e.g. "USB-C port". Single line, preserved as given.
  label: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\x00-\x1f\x7f]+$/)
    .optional(),
  // Attachment order is monotonic; deletions leave gaps, so an ordinal may
  // exceed the live per-capture count. The count cap is on the list length.
  ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type DetailStill = z.infer<typeof DetailStillSchema>;

export function validateDetailStill(input: unknown): DetailStill {
  return DetailStillSchema.parse(input);
}

/** All stills for one capture at one project revision, in attachment order. */
export const DetailStillListSchema = z
  .array(DetailStillSchema)
  .max(MAX_DETAIL_STILLS_PER_CAPTURE)
  .superRefine((stills, ctx) => {
    const [first] = stills;
    if (!first) return;
    const ids = new Set<string>();
    for (const [index, still] of stills.entries()) {
      if (
        still.projectId !== first.projectId ||
        still.captureId !== first.captureId ||
        still.projectRevision !== first.projectRevision
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'Detail stills in a list must share project, capture and revision',
        });
      }
      if (ids.has(still.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Detail still ids must be unique' });
      }
      ids.add(still.id);
      const previous = stills[index - 1];
      if (previous && still.ordinal <= previous.ordinal) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'ordinal'],
          message: 'Detail stills must be in strictly increasing ordinal order',
        });
      }
    }
  });

export function validateDetailStills(input: unknown): DetailStill[] {
  return DetailStillListSchema.parse(input);
}
