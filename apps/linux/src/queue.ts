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
/** One id for each note a person writes, kept across every try at sending it. A note is its words and its
 *  attachments: changed words, or the same words with other photos, are a new note. */
export interface NoteAttempt {
  text: string;
  photos: string[];
  id: string;
}
export const noteAttempt = (
  last: NoteAttempt | undefined,
  text: string,
  photos: string[] = [],
  newId: () => string = () => crypto.randomUUID(),
): NoteAttempt =>
  last && last.text === text && last.photos.length === photos.length && last.photos.every((p, i) => p === photos[i])
    ? last
    : { text, photos: [...photos], id: newId() };

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
