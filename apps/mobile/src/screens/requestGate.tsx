import React, { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * The companion bridge serves one request at a time and rejects overlap.
 * Every screen sends its companion calls through one queue, so a request
 * left running by a screen the user has just left can't collide with the
 * next screen's first call. Never call the gate from inside a gated task.
 */
export type RequestGate = <T>(task: () => Promise<T>) => Promise<T>;

export function createRequestGate(): RequestGate {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const SharedGate = createContext<RequestGate | null>(null);

/** One queue for the whole app. */
export function RequestGateProvider({ children }: { children: ReactNode }) {
  const [gate] = useState(createRequestGate);
  return <SharedGate.Provider value={gate}>{children}</SharedGate.Provider>;
}

/** The app's shared queue, or a queue of the screen's own outside the app. */
export function useRequestGate(): RequestGate {
  const shared = useContext(SharedGate);
  const [own] = useState(createRequestGate);
  return shared ?? own;
}
