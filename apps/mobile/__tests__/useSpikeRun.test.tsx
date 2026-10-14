import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { useSpikeRun } from '../src/spike/useSpikeRun';
import type {
  CaptureSource,
  CaptureHandlers,
  CaptureSample,
} from '../src/capture/captureSource';

async function harness() {
  let handlers!: CaptureHandlers;
  let appState!: (status: AppStateStatus) => void;
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, callback) => {
      appState = callback;
      return { remove: jest.fn() };
    });
  const unsubscribe = jest.fn();
  const source: CaptureSource = {
    kind: 'native',
    isSupported: async () => true,
    start: jest.fn(async () => ({
      framework: 'arkit',
      deviceModel: 'test',
      osVersion: 'test',
      depthEnabled: true,
      meshEnabled: true,
      runId: 'run',
      previewSupported: true,
    })),
    stop: jest.fn(async () => {}),
    subscribe: h => {
      handlers = h;
      return unsubscribe;
    },
  };
  let control!: ReturnType<typeof useSpikeRun>;
  function Harness() {
    control = useSpikeRun(source);
    return null;
  }
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<Harness />);
  });
  return {
    source,
    handlers: () => handlers,
    appState: (value: AppStateStatus) => appState(value),
    unsubscribe,
    control: () => control,
    close: async () => {
      await act(async () => tree.unmount());
      spy.mockRestore();
    },
  };
}
function sample(second: number): CaptureSample {
  return {
    tMs: second * 1000,
    intervalMs: 1000,
    frames: 60,
    thermal: 'nominal',
    tracking: 'normal',
    runId: 'run',
    previewVisible: true,
    trackingNormalThroughout: true,
    renderedFrames: 60,
    anchorId: 'probe',
    anchorVisible: true,
    anchorMethod: 'existing-plane-geometry-center-raycast',
    previewContent: 'known-orange-sphere-diameter-10mm-v1',
    contentAttached: true,
    renderedProbeFrames: 60,
  };
}
test('mount is passive, observation is explicit and a new run resets all evidence', async () => {
  const h = await harness();
  try {
    expect(h.source.start).not.toHaveBeenCalled();
    await act(async () => h.control().start());
    await act(async () => {
      for (let i = 1; i <= 126; i++) h.handlers().onSample(sample(i));
    });
    expect(h.control().state.phase).toBe('done');
    expect(h.control().state.report?.anchor).toBeNull();
    await act(async () =>
      h.control().observe({ observerConfirmed: true, maxDriftMm: null }),
    );
    expect(
      h.control().state.report?.criteria.find(c => c.id === 'anchor')?.verdict,
    ).toBe('pass');
    expect(h.control().state.report?.quantitativeDrift.verdict).toBe(
      'inconclusive',
    );
    await act(async () => h.control().start());
    expect(h.control().state.report).toBeNull();
    expect(h.control().state.latest).toBeNull();
    await act(async () => h.control().stop());
    expect(h.control().state.report?.samples).toEqual([]);
    expect(h.control().state.report?.anchor).toBeNull();
  } finally {
    await h.close();
  }
});
test('background and native interruption stop capture and cannot qualify a run', async () => {
  const h = await harness();
  try {
    await act(async () => h.control().start());
    await act(async () => h.handlers().onSample(sample(1)));
    await act(async () => h.appState('background'));
    expect(h.source.stop).toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
    expect(h.control().state.report?.errors).toContain(
      'App left the foreground during the run.',
    );
    expect(h.control().state.report?.verdict).toBe('inconclusive');
    await act(async () => h.control().start());
    await act(async () => h.handlers().onError('AR session interrupted'));
    expect(h.control().state.phase).toBe('done');
    expect(h.control().state.report?.errors).toEqual([
      'AR session interrupted',
    ]);
    await act(async () => h.handlers().onSample(sample(126)));
    expect(h.control().state.report?.samples).toEqual([]);
  } finally {
    await h.close();
  }
});
