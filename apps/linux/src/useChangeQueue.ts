import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  recoverQueue,
  queueReady,
  markSending,
  type QueuedChange,
} from "./queue";
import type { Project } from "./types";
export function useChangeQueue(
  projects: Project[],
  connected: boolean,
  mutate: (method: string, params: object) => Promise<unknown>,
) {
  const [queue, setQueue] = useState<QueuedChange[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const ref = useRef(queue);
  const serial = useRef(Promise.resolve());
  const sending = useRef(false);
  const save = useCallback(
    (change: (old: QueuedChange[]) => QueuedChange[]) => {
      const work = serial.current.then(async () => {
        const next = change(ref.current);
        await invoke("save_change_queue", { queue: next });
        ref.current = next;
        setQueue(next);
      });
      serial.current = work.catch(() => {});
      return work;
    },
    [],
  );
  useEffect(() => {
    let live = true;
    void invoke<QueuedChange[]>("load_change_queue").then(
      async (q) => {
        if (!live) return;
        const recovered = recoverQueue(q);
        try {
          await invoke("save_change_queue", { queue: recovered });
        } catch (e) {
          if (live) setError(String(e));
          return;
        }
        if (live) {
          ref.current = recovered;
          setQueue(recovered);
          setLoaded(true);
        }
      },
      (e) => setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!connected || !loaded || sending.current) return;
    const project = projects.find((p) =>
      queueReady(
        queue,
        p.id,
        ["touching-up", "printing"].includes(p.state) ||
          !!p.print?.uncertain ||
          p.ask?.status === "open",
      ),
    );
    if (!project) return;
    const item = queueReady(queue, project.id, false)!;
    sending.current = true;
    void (async () => {
      await save((q) => markSending(q, item.id));
      try {
        await mutate("objects.correct", {
          id: item.projectId,
          note: item.note,
          photoNames: item.photos,
          // The queued change's own id: the companion records a note once per id, so a retry after an uncertain
          // send cannot become a second message.
          messageId: item.id,
        });
        await save((q) => q.filter((x) => x.id !== item.id));
      } catch (e) {
        await save((q) =>
          q.map((x) =>
            x.id === item.id
              ? { ...x, state: "uncertain", error: String(e) }
              : x,
          ),
        );
      }
    })()
      .catch((e) => setError(String(e)))
      .finally(() => {
        sending.current = false;
      });
  }, [projects, queue, loaded, connected, mutate, save]);
  return {
    queue,
    error,
    loaded,
    enqueue: async (projectId: string, note: string, photos: string[]) => {
      if (!loaded) throw new Error("Saved changes have not loaded yet.");
      await save((q) => [
        ...q,
        { id: crypto.randomUUID(), projectId, note, photos, state: "queued" },
      ]);
    },
    discard: (id: string) => save((q) => q.filter((x) => x.id !== id)),
    retry: (id: string) =>
      save((q) =>
        q.map((x) =>
          x.id === id ? { ...x, state: "queued", error: undefined } : x,
        ),
      ),
  };
}
