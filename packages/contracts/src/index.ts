import { z } from 'zod';

export * from './detail-still.js';

export const ArtifactRefSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).readonly();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export function validateArtifactRef(input: unknown): ArtifactRef { return ArtifactRefSchema.parse(input); }

export * from './scan-processing.js';
export * from './model-size.js';
export * from './maker-size.js';
