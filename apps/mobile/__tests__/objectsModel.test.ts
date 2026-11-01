import { describeObject, formatSize, objectTitle } from '../src/objects/model';
import type { StmObject } from '../src/objects/types';

const base: StmObject = {
  id: '0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11',
  createdAtMs: Date.UTC(2026, 9, 31, 18, 5),
  updatedAtMs: Date.UTC(2026, 9, 31, 18, 5),
  state: 'new',
  photos: [],
  passes: [],
};
const ready: StmObject = {
  ...base,
  scan: 'scan.usdz',
  state: 'ready',
  passes: [{ startedAtMs: 1, endedAtMs: 2, status: 'done' }],
  current: {
    model: 'current/model.stl',
    renders: ['current/renders/front.png'],
    sizeMm: [61.6, 75.2, 49.4],
    summary: 'Added the two eyes.',
  },
};

it('names an object by its instructions, or as a copy of a scan', () => {
  expect(
    objectTitle({
      ...base,
      instructions: 'A hook for a handle, 25 mm tube. It should hold a cup.',
    }),
  ).toBe('A hook for a handle, 25 mm tube');
  expect(
    objectTitle({
      ...base,
      instructions:
        'A 40 mm cube with a 10 mm round hole straight through the middle.',
    }),
  ).toBe('A 40 mm cube with a 10 mm round hole…');
  expect(objectTitle({ ...base, scan: 'scan.usdz' })).toBe('Copy of your scan');
  expect(objectTitle(base)).toBe('Something new');
});

it('says what is happening in plain words for every state', () => {
  expect(describeObject({ ...base, scan: 'scan.usdz' }).status).toBe(
    'Sending to your Mac…',
  );
  expect(
    describeObject({ ...base, scan: 'scan.usdz', state: 'touching-up' }).status,
  ).toBe(
    "Touching up your scan. This can take a few minutes. We'll let you know when it's ready.",
  );
  expect(
    describeObject({ ...base, instructions: 'A hook', state: 'touching-up' })
      .status,
  ).toBe(
    "Making it. This can take a few minutes. We'll let you know when it's ready.",
  );
  expect(
    describeObject({
      ...ready,
      state: 'touching-up',
      passes: [...ready.passes, { startedAtMs: 3, note: 'thicker' }],
    }).status,
  ).toBe(
    "Making your changes. This can take a few minutes. We'll let you know when it's ready.",
  );
  expect(describeObject(ready).status).toBe('Ready to print');
  expect(describeObject({ ...ready, state: 'printing' }).status).toBe(
    'Printing',
  );
  expect(describeObject({ ...ready, state: 'printed' }).status).toBe('Printed');
});

it('asks for a close-up in one sentence and offers the three answers', () => {
  const view = describeObject({
    ...ready,
    state: 'needs-closeup',
    question: { closeup: 'the clip on the left side' },
  });
  expect(view.status).toBe(
    "Can you send me a close-up of the clip on the left side? I can't see what's happening there.",
  );
  expect(view.actions).toEqual(['openCamera', 'attachPhotos', 'bestGuess']);
});

it('shows the plate only when something is on it, with the override', () => {
  const blocked = describeObject({
    ...ready,
    state: 'printing',
    plate: { item: 'a printed part' },
  });
  expect(blocked.status).toBe(
    "Looks like there's a printed part on your plate. Can you take it off first?",
  );
  expect(blocked.actions).toEqual(['plateClear']);
  const noCamera = describeObject({
    ...ready,
    state: 'printing',
    plate: { noCamera: true },
  });
  expect(noCamera.status).toBe('Check the plate is clear.');
  expect(noCamera.actions).toEqual(['plateClear']);
  expect(describeObject({ ...ready, state: 'printing' }).actions).toEqual([]);
});

it('a ready object prints or takes corrections, with its LiDAR size', () => {
  const view = describeObject(ready);
  expect(view.actions).toEqual(['print', 'correct']);
  expect(view.size).toBe('62 × 75 × 49 mm, ready to print');
  expect(formatSize([10.4, 20.5, 3])).toBe('10 × 21 × 3 mm');
});

it('a failure says why and offers the one thing that fixes it', () => {
  const touchUp = describeObject({
    ...base,
    scan: 'scan.usdz',
    state: 'failed',
    failure: 'Blender is not open on your Mac.',
  });
  expect(touchUp.status).toBe('Blender is not open on your Mac.');
  expect(touchUp.actions).toEqual(['retry']);
  const print = describeObject({
    ...ready,
    state: 'failed',
    failure: 'The printer is busy.',
  });
  expect(print.status).toBe('The printer is busy.');
  expect(print.actions).toEqual(['print', 'correct']);
  expect(describeObject({ ...base, state: 'failed' }).status).toBe(
    'Something went wrong on your Mac.',
  );
});

it('busy states are marked so the page keeps itself up to date', () => {
  expect(describeObject({ ...base, state: 'touching-up' }).busy).toBe(true);
  expect(describeObject({ ...ready, state: 'printing' }).busy).toBe(true);
  expect(describeObject(ready).busy).toBe(false);
});

it('an object with nothing sent yet asks for a scan or photos, or to make it from the instructions', () => {
  const empty = describeObject(base);
  expect(empty.status).toBe('Waiting for a scan or photos.');
  expect(empty.busy).toBe(false);
  expect(empty.actions).toEqual(['scan', 'attachPhotos']);
  expect(describeObject({ ...base, instructions: 'A hook' }).actions).toEqual([
    'scan',
    'attachPhotos',
    'makeIt',
  ]);
  expect(describeObject({ ...base, photos: ['a.jpg'] }).status).toBe(
    'Sending to your Mac…',
  );
});

it('a print that may already have started asks the user to check the printer first', () => {
  const view = describeObject({
    ...ready,
    state: 'failed',
    failure:
      'The printer may have started this print. Check the printer before printing again.',
    print: { bundleId: 'b', uncertain: true },
  });
  expect(view.actions).toEqual(['printChecked', 'correct']);
});

it('a send that stopped part way can be finished', () => {
  expect(describeObject({ ...base, scan: 'scan.usdz' }).actions).toEqual([
    'finishSending',
  ]);
});
