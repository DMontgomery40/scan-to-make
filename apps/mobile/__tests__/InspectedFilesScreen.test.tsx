import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Text, AppState } from 'react-native';
import { InspectedFilesScreen } from '../src/screens/InspectedFilesScreen';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
const mockCancel = jest.fn(async () => {}),
  mockSync = jest.fn(),
  mockList = jest.fn(),
  mockOpen = jest.fn(),
  mockExport = jest.fn();
jest.mock('../src/capture/retainedCaptures', () => ({
  captureNative: () => ({ cancel: mockCancel }),
  CaptureClient: jest.fn().mockImplementation(() => ({
    native: { cancel: mockCancel },
    sync: mockSync,
  })),
}));
jest.mock('../src/prepared/preparedFiles', () => ({
  ...jest.requireActual('../src/prepared/preparedFiles'),
  preparedNative: () => ({ cancel: mockCancel }),
  PreparedFilesClient: jest.fn().mockImplementation(() => ({
    native: { cancel: mockCancel },
    list: mockList,
    open: mockOpen,
    export: mockExport,
  })),
}));
const ack = { etag: '"' + 'a'.repeat(64) + '"', snapshot: 'snapshot' },
  summary = {
    jobId: 'fixture',
    jobSha256: 'digest',
    model: 'p1s',
    plateIndex: 0,
    printableArtifact: {
      mediaType: 'model/3mf',
      byteLength: 42,
      sha256: 'hash',
    },
  };
const job = {
  printableArtifact: summary.printableArtifact,
  selection: { plateIndex: 0 },
  inspection: {
    receipt: {
      inspection: {
        model: 'p1s',
        nozzleDiameters: [0.4],
        materials: ['PLA'],
        usedFilamentPositions: [0],
        bedType: 'textured pei plate',
      },
    },
  },
};
const props = {
  id: 'project',
  repository: {} as SavedProjects,
  onBack: jest.fn(),
  onCompanion: jest.fn(),
};
function shown(tree: Renderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(Text)
    .map(t => [t.props.children].flat().join(''));
}
async function press(tree: Renderer.ReactTestRenderer, label: string) {
  await act(async () => {
    tree.root
      .find(
        n =>
          n.props.accessibilityRole === 'button' &&
          n.props.accessibilityLabel === label &&
          typeof n.props.onPress === 'function',
      )
      .props.onPress();
  });
}
async function mount() {
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(<InspectedFilesScreen {...props} />);
  });
  return tree;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  mockSync.mockResolvedValue(ack);
  mockList.mockResolvedValue({
    jobs: [summary],
    nextCursor: null,
    unreadable: 0,
  });
  mockOpen.mockResolvedValue({ job });
  mockExport.mockResolvedValue({ path: 'file' });
});
test('empty page continues, verified selection precedes details and exact export', async () => {
  mockList.mockResolvedValueOnce({
    jobs: [],
    mode: 'legacy',
    nextCursor: 'next',
    unreadable: 1,
  });
  const tree = await mount();
  expect(shown(tree)).toContain('Continue to look for files.');
  await press(tree, 'Load more files');
  expect(mockList).toHaveBeenLastCalledWith('project', ack, 'next', 'legacy');
  expect(shown(tree)).not.toContain('File inspection');
  await press(tree, 'Review file 1');
  expect(mockOpen).toHaveBeenCalledWith('project', 'fixture', ack, summary);
  expect(shown(tree)).toContain('File inspection');
  await press(tree, 'Save file');
  expect(mockExport).toHaveBeenCalledWith('project', 'fixture', ack, summary);
  expect(shown(tree)).toContain('Saved to this app’s folder in Files.');
  await act(async () => tree.unmount());
});
test('stale cursor clears old handles and refresh replaces the page', async () => {
  mockList
    .mockResolvedValueOnce({
      jobs: [summary],
      mode: 'legacy',
      nextCursor: 'next',
      unreadable: 0,
    })
    .mockRejectedValueOnce(Object.assign(Error(), { code: 'cursor-stale' }));
  const tree = await mount();
  await press(tree, 'Load more files');
  expect(shown(tree)).toContain(
    'The file list changed. Refresh to see the current files.',
  );
  expect(shown(tree)).not.toContain('File 1 · 3MF');
  await press(tree, 'Refresh files');
  expect(mockList).toHaveBeenLastCalledWith('project', ack);
  await act(async () => tree.unmount());
});
test('connection overlay invalidates a delayed verified detail and later refresh works', async () => {
  let release!: (x: unknown) => void;
  mockOpen.mockReturnValue(
    new Promise(r => {
      release = r;
    }),
  );
  const tree = await mount();
  await press(tree, 'Review file 1');
  await act(async () =>
    tree.update(<InspectedFilesScreen {...props} paused />),
  );
  await act(async () => release({ job }));
  expect(shown(tree)).not.toContain('File inspection');
  await act(async () => tree.update(<InspectedFilesScreen {...props} />));
  await press(tree, 'Refresh files');
  expect(shown(tree)).toContain('File 1 · 3MF');
  await act(async () => tree.unmount());
});
test('backgrounding removes verified details until a fresh lookup', async () => {
  let listener!: (state: import('react-native').AppStateStatus) => void;
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, callback) => {
      listener = callback;
      return { remove: jest.fn() };
    });
  const tree = await mount();
  await press(tree, 'Review file 1');
  await act(async () => listener('background'));
  expect(shown(tree)).not.toContain('File inspection');
  expect(mockCancel).toHaveBeenCalled();
  await act(async () => tree.unmount());
  spy.mockRestore();
});

test('verified produced files show companion provenance without imported-file or calibration claims', async () => {
  mockOpen.mockResolvedValue({
    job: { ...job, production: { slicer: { version: '02.08.02.61' } } },
  });
  const tree = await mount();
  await press(tree, 'Review file 1');
  expect(shown(tree)).toContain('SLICED BY YOUR COMPANION');
  expect(shown(tree).some(s => s.includes('02.08.02.61'))).toBe(true);
  expect(shown(tree)).not.toContain('IMPORTED SLICED FILE');
  expect(
    shown(tree).some(s => s.includes('Physical fit still needs checking')),
  ).toBe(true);
  await act(async () => tree.unmount());
});
