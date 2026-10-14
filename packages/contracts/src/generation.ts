import { z } from 'zod';
import {
  ArtifactRefSchema,
  DrawerFitSpecSchema,
  ProjectFitSpecSchema,
  type ProjectFitSpec,
} from './index.js';

export const MAX_GENERATION_REQUEST_BYTES = 256 * 1024;
export const MAX_GENERATED_STL_BYTES = 32 * 1024 * 1024;
export const MAX_GENERATION_RESPONSE_BYTES =
  Math.ceil(MAX_GENERATED_STL_BYTES / 3) * 4 +
  MAX_GENERATION_REQUEST_BYTES +
  4096;
export const GENERATION_TIMEOUT_MS = 30_000;

export const GenerationRequestSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  sourceFit: ProjectFitSpecSchema,
});
const point = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const bounds = z
  .strictObject({ min: point, max: point })
  .refine(
    (value) => value.min.every((n, i) => n <= value.max[i]!),
    'Invalid geometry bounds'
  );
export const GenerationReceiptSchema = z.strictObject({
  sourceFit: DrawerFitSpecSchema,
  artifact: ArtifactRefSchema.unwrap().extend({
    mediaType: z.literal('model/stl'),
    byteLength: z.number().int().positive().max(MAX_GENERATED_STL_BYTES),
  }),
  geometry: z.strictObject({
    encoding: z.enum(['ascii', 'binary']),
    triangleCount: z.number().int().positive().max(500_000),
    boundsMm: bounds,
  }),
  generator: z.strictObject({
    name: z.literal('drawer-tray'),
    version: z.literal('0.1.0'),
  }),
  assumptions: z.strictObject({ cornerRadiusAssumedMm: z.literal(0) }),
  status: z.literal('preview-only'),
});
export const GenerationResponseSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  receipt: GenerationReceiptSchema,
  stlBase64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_GENERATED_STL_BYTES / 3) * 4),
});
export const GenerationErrorCodeSchema = z.enum([
  'invalid-request',
  'payload-too-large',
  'unsupported-template',
  'busy',
  'generation-failed',
  'generation-timeout',
  'invalid-output',
  'forbidden',
  'not-found',
  'method-not-allowed',
  'unsupported-media-type',
]);
export const GenerationErrorSchema = z.strictObject({
  error: z.strictObject({
    code: GenerationErrorCodeSchema,
    message: z.string(),
  }),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
export type GenerationResponse = z.infer<typeof GenerationResponseSchema>;
export type GenerationReceipt = z.infer<typeof GenerationReceiptSchema>;
export type GenerationErrorCode = z.infer<typeof GenerationErrorCodeSchema>;

const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text: string): Uint8Array {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const body = text.slice(0, text.length - padding);
  if (
    text.length % 4 !== 0 ||
    /[^A-Za-z0-9+/]/.test(body) ||
    (padding === 2 && (alphabet.indexOf(body.at(-1)!) & 15) !== 0) ||
    (padding === 1 && (alphabet.indexOf(body.at(-1)!) & 3) !== 0)
  ) {
    throw new Error('Invalid canonical artifact base64');
  }
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  const sextet = (index: number) =>
    text[index] === '=' ? 0 : alphabet.indexOf(text[index]!);
  for (let i = 0, out = 0; i < text.length; i += 4) {
    const value =
      (sextet(i) << 18) |
      (sextet(i + 1) << 12) |
      (sextet(i + 2) << 6) |
      sextet(i + 3);
    bytes[out++] = value >>> 16;
    if (out < bytes.length) bytes[out++] = value >>> 8;
    if (out < bytes.length) bytes[out++] = value;
  }
  return bytes;
}

/** Integrity of a response to this request; the saved repository separately checks current-fit freshness. */
export async function verifyGenerationResponse(
  input: unknown,
  expectedSource: ProjectFitSpec,
  sha256: (bytes: Uint8Array) => Promise<string>
): Promise<{ receipt: GenerationReceipt; bytes: Uint8Array }> {
  // Zod detaches before any await and serializes these closed shapes in schema order.
  const response = GenerationResponseSchema.parse(input);
  const expected = ProjectFitSpecSchema.parse(expectedSource);
  if (JSON.stringify(response.receipt.sourceFit) !== JSON.stringify(expected)) {
    throw new Error('Generation source does not match the requested fit');
  }
  const bytes = decodeBase64(response.stlBase64);
  if (bytes.length !== response.receipt.artifact.byteLength)
    throw new Error('Generated artifact length mismatch');
  if ((await sha256(bytes)) !== response.receipt.artifact.sha256)
    throw new Error('Generated artifact digest mismatch');
  return { receipt: response.receipt, bytes };
}
