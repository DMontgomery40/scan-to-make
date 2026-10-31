import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import {
  RequestGateProvider,
  createRequestGate,
  useRequestGate,
  type RequestGate,
} from '../src/screens/requestGate';

test('the gate runs one task at a time, in order, past failures', async () => {
  const gate = createRequestGate();
  const log: string[] = [];
  let release!: () => void;
  const first = gate(
    () =>
      new Promise<void>(resolve => {
        log.push('first starts');
        release = () => {
          log.push('first ends');
          resolve();
        };
      }),
  );
  const failing = gate(async () => {
    log.push('second runs');
    throw Error('rejected');
  });
  const third = gate(async () => {
    log.push('third runs');
    return 3;
  });
  await Promise.resolve();
  expect(log).toEqual(['first starts']);
  release();
  await first;
  await expect(failing).rejects.toThrow('rejected');
  await expect(third).resolves.toBe(3);
  expect(log).toEqual([
    'first starts',
    'first ends',
    'second runs',
    'third runs',
  ]);
});

test('screens share the app gate inside the provider, else keep their own', async () => {
  const seen: RequestGate[] = [];
  function Probe() {
    seen.push(useRequestGate());
    return null;
  }
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <>
        <RequestGateProvider>
          <Probe />
          <Probe />
        </RequestGateProvider>
        <Probe />
      </>,
    );
  });
  expect(seen[0]).toBe(seen[1]);
  expect(seen[2]).not.toBe(seen[0]);
  await act(async () => tree.unmount());
});
