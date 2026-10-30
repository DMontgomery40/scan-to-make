import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { NativeModules, Text, Alert } from 'react-native';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import { RetainedCapturesScreen } from '../src/screens/RetainedCapturesScreen';

async function fixture(supported = true) {
  const records = new Map<string, string>();
  const repo = createSavedProjects({
    listIds: async () => [...records.keys()],
    read: async id => records.get(id) ?? null,
    compareAndSwap: async (id, old, next) => {
      if ((records.get(id) ?? null) !== old) return false;
      records.set(id, next);
      return true;
    },
  });
  const created = await repo.create({
    id: 'one',
    brief: { object: 'Box', context: 'Desk', addition: 'Lid' },
    fit: null,
  });
  if (created.status !== 'ok') throw Error();
  const requests: string[] = [];
  const drafts: unknown[] = [];
  NativeModules.RetainedCaptureBridge = {
    context: async () => {
      throw Error('Connect your companion');
    },
    read: async () => null,
    cancel: async () => {},
    pick: async () => {
      requests.push('pick');
      throw Error('File selection cancelled');
    },
  };
  NativeModules.NativeCaptureCoordinator = {
    status: async () => ({ supported, activeRunID: null }),
    drafts: async () => drafts,
    start: async (origin: unknown) => {
      const draft = {
        formatVersion: 1,
        runID: '14f6ca24-44fc-4984-9634-c14eef4eebc9',
        origin,
        createdAt: '2026-01-01T00:00:00Z',
        status: 'ready',
        file: {
          sha256: 'a'.repeat(64),
          byteLength: 123,
          mediaType: 'model/vnd.usdz+zip',
        },
      };
      requests.push('scan');
      drafts.push(draft);
      return draft;
    },
    stop: async () => {},
  };
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <RetainedCapturesScreen
        id="one"
        repository={repo}
        onBack={() => {}}
        onCompanion={() => {}}
      />,
    );
  });
  return { tree, requests, project: created.project };
}
function button(tree: Renderer.ReactTestRenderer, name: string) {
  return tree.root.find(
    n =>
      n.props.accessibilityRole === 'button' &&
      n.props.accessibilityLabel === name &&
      typeof n.props.onPress === 'function',
  );
}
function text(tree: Renderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat().join(''))
    .join('\n');
}
async function press(tree: Renderer.ReactTestRenderer, name: string) {
  await act(async () => {
    button(tree, name).props.onPress();
  });
}
afterEach(() => {
  delete NativeModules.NativeCaptureCoordinator;
  delete NativeModules.RetainedCaptureBridge;
  jest.restoreAllMocks();
});
test('unpaired project can scan locally and keep a ready draft without upload', async () => {
  const { tree, requests } = await fixture();
  await press(tree, 'Scan object');
  expect(requests).toEqual(['scan']);
  expect(text(tree)).toContain('Local scan 1');
  expect(text(tree)).toContain('Ready to add');
  expect(button(tree, 'Add scan 1 to this project')).toBeTruthy();
  await act(async () => tree.unmount());
});
test('unsupported hardware preserves Files import and explains unavailable scanning', async () => {
  const { tree, requests } = await fixture(false);
  expect(button(tree, 'Scan object').props.disabled).toBe(true);
  expect(text(tree)).toContain('Choose a USDZ file');
  await press(tree, 'Choose USDZ capture');
  expect(requests).toEqual(['pick']);
  await act(async () => tree.unmount());
});
test('choosing a changed destination requires explicit confirmation before import', async () => {
  const { tree, requests } = await fixture();
  await press(tree, 'Scan object');
  NativeModules.RetainedCaptureBridge.context = async () => 'host|new-device';
  const prompt = jest.spyOn(Alert, 'alert');
  await press(tree, 'Choose destination for scan 1');
  expect(prompt).toHaveBeenCalled();
  expect(requests).toEqual(['scan']);
  await act(async () => tree.unmount());
});

test('ordinary screen hands a completed native draft through real importer and verified reopen', async () => {
  const { tree, requests, project } = await fixture();
  const history = new Map<string, string>();
  const ref = (c: string, mediaType: string) => ({
    sha256: c.repeat(64),
    byteLength: 123,
    mediaType,
  });
  const original = ref('a', 'model/vnd.usdz+zip');
  const retained = {
    captureId: 'native-capture-1',
    binding: {
      projectId: 'one',
      projectRevision: 0,
      capture: {
        formatVersion: '0.1.0',
        original,
        derived: ref('b', 'model/obj'),
        conversionReport: ref('c', 'application/json'),
        converter: { name: 'capture-mesh-convert', version: '0.1.0' },
        provenance: {
          metersPerUnit: 1,
          unitsAuthored: true,
          upAxis: 'Y',
          coordinates: 'world',
          transformPolicy: 'composed-once-native-unrescaled',
          contributingLayers: [
            {
              identifier: 'root.usdc',
              artifact: ref('d', 'application/octet-stream'),
            },
          ],
        },
        qualification: { status: 'qualified', reasons: [] },
        evidence: {
          metricAccuracy: 'unknown',
          surfaceCompleteness: 'unknown',
          physicalFit: 'unknown',
        },
      },
    },
  };
  Object.assign(NativeModules.RetainedCaptureBridge, {
    context: async () => 'host|device',
    read: async (key: string) => history.get(key) ?? null,
    write: async (key: string, value: string) => {
      history.set(key, value);
    },
    adoptNativeOutput: async () => original,
    request: async (options: { method: string; path: string }) => {
      requests.push(options.method);
      return {
        status: options.method === 'POST' ? 201 : 200,
        body: JSON.stringify(
          options.path.includes('/captures') ? retained : project,
        ),
        etag: '"' + 'a'.repeat(64) + '"',
      };
    },
  });
  await press(tree, 'Scan object');
  expect(requests).toEqual(['scan']);
  await press(tree, 'Add scan 1 to this project');
  expect(requests).toEqual(['scan', 'GET', 'POST', 'GET']);
  expect(text(tree)).toContain('Review capture');
  expect(text(tree)).toContain('Capture imported and verified.');
  expect(button(tree, 'Review converted mesh')).toBeTruthy();
  expect(button(tree, 'Export original USDZ')).toBeTruthy();
  expect(
    [...history.values()].some(
      value =>
        JSON.parse(value).captures?.[0]?.captureId === 'native-capture-1',
    ),
  ).toBe(true);
  await act(async () => tree.unmount());
});
