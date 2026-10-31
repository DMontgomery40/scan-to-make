import type {
  ListProjectsResult,
  SavedProject,
  SavedProjects,
} from '@scan-to-make/contracts/saved-project';
import {
  objectCaptureNative,
  type NativeCaptureDraft,
} from '../capture/nativeObjectCapture';
import { CaptureClient, captureNative } from '../capture/retainedCaptures';

/**
 * Scan something opens the camera before anything is named, so its project
 * starts with an empty brief and gets its name after the scan. People see
 * "Untitled project" until then, never this value.
 */
export const unnamedBrief = (): SavedProject['brief'] => ({
  object: '',
  context: '',
  addition: '',
});

// The camera keeps a draft of every scan it opens. One that was stopped
// before it made a model has nothing to add; a model, or a scan still
// running, does.
const keepsSomething = (draft: NativeCaptureDraft) =>
  draft.status === 'ready' ||
  draft.status === 'capturing' ||
  draft.status === 'stopping' ||
  draft.file !== undefined;

const isUnnamed = (project: SavedProject) =>
  project.brief.object === '' &&
  project.brief.context === '' &&
  project.brief.addition === '' &&
  project.fit == null &&
  project.preview == null &&
  project.acceptedArtifact == null;

/**
 * An unnamed project left by a scan that was stopped, for the next Scan
 * something to use again rather than leave another "Untitled project". Only a
 * project with nothing kept for it qualifies: no scan on this phone, none on
 * your Mac, and no upload in doubt. Anything uncertain starts a new one.
 */
export async function emptyUnnamedProject(
  listing: ListProjectsResult | null,
  repository: SavedProjects,
): Promise<string | null> {
  if (listing?.status !== 'ok') return null;
  const unnamed = listing.entries.flatMap(entry =>
    entry.result.status === 'ok' && isUnnamed(entry.result.project)
      ? [entry.result.project.id]
      : [],
  );
  if (unnamed.length === 0) return null;
  try {
    const scanner = objectCaptureNative();
    if (!scanner) return null;
    const drafts = await scanner.drafts();
    const client = new CaptureClient(repository, captureNative());
    for (const id of unnamed) {
      if (
        drafts.some(
          draft => draft.origin.projectId === id && keepsSomething(draft),
        )
      )
        continue;
      const state = await client.state(id);
      if (
        state.captures.length === 0 &&
        !state.pending &&
        !state.unconfirmed?.length
      )
        return id;
    }
  } catch {}
  return null;
}
