export interface QueuedChange {
  id: string;
  projectId: string;
  note: string;
  photos: string[];
  state: "queued" | "sending" | "uncertain";
  error?: string;
}
export const recoverQueue = (queue: QueuedChange[]): QueuedChange[] =>
  queue.map((q) =>
    q.state === "sending"
      ? {
          ...q,
          state: "uncertain",
          error:
            "The app closed while this request was being sent. Check the conversation before retrying.",
        }
      : q,
  );
/** One id for each note a person writes, kept across every try at sending it; changed words are a new note. */
export const noteAttempt = (
  last: { text: string; id: string } | undefined,
  text: string,
  newId: () => string = () => crypto.randomUUID(),
) => (last?.text === text ? last : { text, id: newId() });

export const queueReady = (
  queue: QueuedChange[],
  projectId: string,
  active: boolean,
) =>
  active
    ? undefined
    : queue.find((q) => q.projectId === projectId && q.state === "queued");
export const markSending = (
  queue: QueuedChange[],
  id: string,
): QueuedChange[] =>
  queue.map((q) => (q.id === id ? { ...q, state: "sending" } : q));
