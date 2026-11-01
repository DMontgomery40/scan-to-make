import { objectCapture } from '../src/objects/capture';
import type {
  NativeCaptureDraft,
  ObjectCaptureNative,
} from '../src/capture/nativeObjectCapture';

const ID = '0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11';
const draft = (
  status: NativeCaptureDraft['status'],
  projectId = ID,
  runID = 'run-1',
): NativeCaptureDraft => ({
  formatVersion: 1,
  runID,
  origin: { projectId, revision: 0, snapshot: '{}', context: null },
  createdAt: '2026-10-31T00:00:00Z',
  status,
});
function native(
  start: NativeCaptureDraft,
  drafts: NativeCaptureDraft[] = [],
  lidar = true,
): ObjectCaptureNative {
  return {
    status: jest.fn(async () => ({
      supported: true,
      lidar,
      activeRunID: null,
    })),
    drafts: jest.fn(async () => drafts),
    start: jest.fn(async () => start),
    stop: jest.fn(async () => undefined),
  };
}

it('a scan belongs to its object and counts only when a model was made', async () => {
  const done = native(draft('ready'));
  expect(await objectCapture(done).scan(ID)).toBe('run-1');
  expect(done.start).toHaveBeenCalledWith({
    projectId: ID,
    revision: 0,
    snapshot: '{}',
    context: null,
  });
  expect(await objectCapture(native(draft('stopped'))).scan(ID)).toBeNull();
});

it("a finished scan that wasn't sent is found again by its object", async () => {
  const capture = objectCapture(
    native(draft('ready'), [
      draft('ready', 'other', 'run-x'),
      draft('stopped', ID, 'run-2'),
      draft('ready', ID, 'run-3'),
    ]),
  );
  expect(await capture.finished(ID)).toBeNull();
  const later = objectCapture(
    native(draft('ready'), [draft('ready', ID, 'run-3')]),
  );
  expect(await later.finished(ID)).toBe('run-3');
});

it('only LiDAR devices can scan, and no module means no scanning', async () => {
  expect(
    await objectCapture(native(draft('ready'), [], false)).available(),
  ).toBe(false);
  expect(await objectCapture(native(draft('ready'))).available()).toBe(true);
  expect(await objectCapture(null).available()).toBe(false);
  expect(await objectCapture(null).scan(ID)).toBeNull();
});
