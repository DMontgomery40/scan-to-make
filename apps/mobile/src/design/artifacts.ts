import { NativeModules } from 'react-native';
import {
  ProjectFitSpecSchema,
  type ArtifactRef,
} from '@scan-to-make/contracts';
import {
  GenerationErrorSchema,
  verifyGenerationResponse,
} from '@scan-to-make/contracts/generation';
import type {
  SavedArtifactBinding,
  SavedProject,
  SavedProjects,
} from '@scan-to-make/contracts/saved-project';

export interface ArtifactNative {
  generate(body: string): Promise<{ status: number; body: string }>;
  cancel(): Promise<void>;
  hashBase64(bytes: string): Promise<string>;
  cache(bytes: string, digest: string, length: number): Promise<string>;
  verifyCache(digest: string, length: number): Promise<string>;
  share(
    digest: string,
    length: number,
    name: string,
  ): Promise<{
    completed: boolean;
    path: string;
    sha256: string;
    byteLength: number;
  }>;
}
export function artifactNative(): ArtifactNative {
  const native = NativeModules.ArtifactBridge as ArtifactNative | undefined;
  if (!native) {
    throw new Error(
      'Generated previews are available in the iOS app on this Mac.',
    );
  }
  return native;
}
/* eslint-disable no-bitwise -- canonical base64 encoding of bounded bytes */
export function encodeBytes(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk +=
      alphabet[n >>> 18] +
      alphabet[(n >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') +
      (i + 2 < bytes.length ? alphabet[n & 63] : '=');
    if (chunk.length >= 16384) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  chunks.push(chunk);
  return chunks.join('');
}
/* eslint-enable no-bitwise */
const ERROR_COPY: Record<string, string> = {
  busy: 'The local design service is busy. Try again shortly.',
  unavailable:
    'The local design service is unavailable. Start it on this Mac, then try again.',
  timeout: 'The design took too long. Try again.',
  'generation-timeout': 'The design took too long. Try again.',
  'unsupported-template':
    'This template is not supported by the local design service.',
  cancelled: 'Generation cancelled. Your saved project is unchanged.',
  'payload-too-large': 'The design response exceeded the download limit.',
  'cache-invalid':
    'The design file is missing or damaged. Preview and export are unavailable.',
  'cache-error':
    'The design file could not be saved. Your project is unchanged.',
};
export function artifactError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return (
    (code && ERROR_COPY[code]) ||
    (error instanceof Error
      ? error.message
      : 'The design could not be loaded. Try again.')
  );
}
export type GenerationToken = { cancelled: boolean };
function check(token: GenerationToken) {
  if (token.cancelled) {
    throw Object.assign(new Error(ERROR_COPY.cancelled), { code: 'cancelled' });
  }
}
export async function generateAndAttach(
  project: SavedProject,
  repository: SavedProjects,
  native: ArtifactNative,
  token: GenerationToken,
): Promise<SavedProject> {
  const sourceFit = ProjectFitSpecSchema.parse(project.fit);
  const response = await native.generate(
    JSON.stringify({ formatVersion: '0.1.0', sourceFit }),
  );
  check(token);
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('The service returned an invalid design response.');
  }
  if (response.status !== 200) {
    const error = GenerationErrorSchema.safeParse(payload);
    const code = error.success ? error.data.error.code : 'invalid-output';
    throw Object.assign(
      new Error(
        ERROR_COPY[code] ?? 'The service could not generate this design.',
      ),
      { code },
    );
  }
  let verified;
  try {
    verified = await verifyGenerationResponse(payload, sourceFit, bytes =>
      native.hashBase64(encodeBytes(bytes)),
    );
  } catch {
    throw new Error(
      'The returned design did not match this project or its verified bytes. Nothing was attached.',
    );
  }
  check(token);
  const binding = {
    sourceFit: verified.receipt.sourceFit,
    artifact: verified.receipt.artifact,
  };
  await native.cache(
    encodeBytes(verified.bytes),
    binding.artifact.sha256,
    binding.artifact.byteLength,
  );
  check(token);
  const latest = await repository.load(project.id);
  if (latest.status !== 'ok') {
    throw new Error(
      'Your saved project could not be reloaded. The design was not attached.',
    );
  }
  check(token);
  const attached = await repository.change(
    project.id,
    latest.project.revision,
    { kind: 'attach-preview', ...binding },
  );
  if (attached.status !== 'ok') {
    throw new Error(
      'Your project changed while the design was being made. Reload it and generate again.',
    );
  }
  return attached.project;
}
export const sameBinding = (
  a: SavedArtifactBinding | null,
  b: SavedArtifactBinding | null,
) => JSON.stringify(a) === JSON.stringify(b);
export async function acceptArtifact(
  projectId: string,
  binding: SavedArtifactBinding,
  repository: SavedProjects,
  native: ArtifactNative,
): Promise<SavedProject> {
  await native.verifyCache(
    binding.artifact.sha256,
    binding.artifact.byteLength,
  );
  const latest = await repository.load(projectId);
  if (latest.status !== 'ok') {
    throw new Error('Your saved project could not be reloaded.');
  }
  const result = await repository.change(projectId, latest.project.revision, {
    kind: 'accept-preview',
    ...binding,
  });
  if (result.status !== 'ok') {
    throw new Error(
      'This preview is no longer current. Reload the project before accepting.',
    );
  }
  return result.project;
}
export async function shareArtifact(
  projectId: string,
  binding: SavedArtifactBinding,
  repository: SavedProjects,
  native: ArtifactNative,
) {
  await native.verifyCache(
    binding.artifact.sha256,
    binding.artifact.byteLength,
  );
  const latest = await repository.load(projectId);
  if (
    latest.status !== 'ok' ||
    !sameBinding(latest.project.acceptedArtifact, binding)
  ) {
    throw new Error(
      'This design is no longer accepted for the current project.',
    );
  }
  return native.share(
    binding.artifact.sha256,
    binding.artifact.byteLength,
    `drawer-r${binding.sourceFit.revision}-${binding.artifact.sha256.slice(
      0,
      8,
    )}`,
  );
}
export async function verifyCached(artifact: ArtifactRef) {
  return artifactNative().verifyCache(artifact.sha256, artifact.byteLength);
}
