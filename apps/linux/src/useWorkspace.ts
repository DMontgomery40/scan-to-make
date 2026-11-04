import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./bridge";
import { ReadOrder, newerProject } from "./domain";
import type { Project, Printer, RawQuestion } from "./types";
export function useWorkspace(enabled: boolean) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [questions, setQuestions] = useState<RawQuestion[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [eventNotice, setEventNotice] = useState("");
  const [jobs, setJobs] = useState<
    {
      kind: string;
      projectName?: string;
      job: { status?: string; progress?: number };
    }[]
  >([]);
  const order = useRef(new ReadOrder());
  const reading = useRef(false);
  const cursor = useRef(0);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const ticket = order.current.begin();
    try {
      const [a, b] = await Promise.all([
        call<{ objects: Project[] }>("objects.list"),
        call<{ destinations: Printer[] }>("objects.printers"),
      ]);
      if (order.current.accept(ticket)) {
        setProjects((old) =>
          a.objects.map((p) =>
            newerProject(
              old.find((x) => x.id === p.id),
              p,
            ),
          ),
        );
        setPrinters(b.destinations);
        setConnected(true);
        setError("");
      }
    } catch (e) {
      setConnected(false);
      setError(String(e));
    } finally {
      reading.current = false;
    }
  }, []);
  const apply = useCallback((project: Project) => {
    order.current.invalidate();
    setProjects((all) =>
      [
        newerProject(
          all.find((p) => p.id === project.id),
          project,
        ),
        ...all.filter((p) => p.id !== project.id),
      ].sort((a, b) => b.createdAtMs - a.createdAtMs),
    );
  }, []);
  const mutate = useCallback(
    async (method: string, params: object = {}) => {
      order.current.invalidate();
      try {
        const result = await call<{ object?: Project }>(method, params);
        if (result.object) apply(result.object);
        return result;
      } finally {
        void refresh();
      }
    },
    [apply, refresh],
  );
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void refresh();
    const confirmations = async () => {
      try {
        const reply = await call<{ items: RawQuestion[] }>(
          "confirmations.list",
        );
        if (live) setQuestions(reply.items);
      } catch {
        /* main status owns connectivity */
      }
    };
    void confirmations();
    const jobsRead = async () => {
      try {
        const page = await call<{ items: typeof jobs }>("jobs.list", {
          limit: 50,
        });
        if (live) setJobs(page.items);
      } catch {
        /* jobs are supplemental */
      }
    };
    void jobsRead();
    const interval = setInterval(() => {
      if (!document.hidden) {
        void refresh();
        void confirmations();
      }
    }, 5000);
    const jobsTimer = setInterval(() => {
      if (!document.hidden) void jobsRead();
    }, 15000);
    const events = async () => {
      while (live) {
        try {
          const page = await call<{
            next: number;
            events: { type: string; title: string; body: string }[];
            reset?: boolean;
            truncated?: boolean;
          }>("events.wait", {
            after: cursor.current,
            timeoutMs: 25000,
            limit: 100,
          });
          if (!live) return;
          cursor.current = page.next;
          if (page.events.length || page.reset || page.truncated) {
            await refresh();
            await confirmations();
            const update = page.events.findLast((e) =>
              e.type.startsWith("mcp.update."),
            );
            if (update) setEventNotice(`${update.title} ${update.body}`);
          }
        } catch {
          if (live) {
            setConnected(false);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            void refresh();
          }
        }
      }
    };
    void events();
    const foreground = () => {
      if (!document.hidden) {
        void refresh();
        void confirmations();
      }
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      live = false;
      clearInterval(interval);
      clearInterval(jobsTimer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [enabled, refresh]);
  return {
    projects,
    printers,
    questions,
    error,
    connected,
    eventNotice,
    jobs,
    refresh,
    apply,
    mutate,
  };
}
