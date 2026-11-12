import type { DesignVersion, PrintAttempt, Project } from "./types";

/**
 * A project's designs and prints (#616 slice 1), ported from CounterpartKit `DesignHistory` so the words and the rules
 * are the iPhone's and the Mac's. The newest design is the last of `versions`; it is a default, never a stored pointer.
 * `packages/contracts/fixtures/project-versions.json` is read by Kit, the contracts and `domain.test.ts`.
 */

/** "Nov 4", in this computer's time zone, as the Mac's words write it. */
export function designDate(at: number, timeZone?: string): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) });
}

/** How a person points at a design (DESIGN.md §2): its pass's first sentence, else its date. */
export function designLabel(version: DesignVersion, timeZone?: string): string {
  const line = version.result.summary?.split("\n")[0]?.trim();
  if (!line) return designDate(version.sealedAtMs, timeZone);
  const end = line.indexOf(". ");
  return end < 0 ? line : line.slice(0, end) + ".";
}

export function attempts(p: Project, version: DesignVersion): PrintAttempt[] {
  return (p.prints ?? []).filter((attempt) => attempt.versionId === version.id);
}

/** When this design was printed: its own answer, else its latest attempt that finished. */
export function printedAt(p: Project, version: DesignVersion): number | undefined {
  if (version.printedAtMs !== undefined) return version.printedAtMs;
  const done = attempts(p, version)
    .filter((attempt) => attempt.monitor?.endState === "done")
    .map((attempt) => {
      const ended = attempt.monitor?.endedAt ? Date.parse(attempt.monitor.endedAt) : NaN;
      return Number.isFinite(ended) ? ended : attempt.startedAtMs;
    });
  return done.length ? Math.max(...done) : undefined;
}

/** Attempts on this design whose end was never kept (made before attempts were recorded; their frames survive). */
export function unknownEnds(p: Project, version: DesignVersion): number {
  return attempts(p, version).filter((attempt) => attempt.monitor?.endState === undefined).length;
}

export function designHistory(p: Project, timeZone?: string) {
  const versions = p.versions ?? [];
  const latest = versions.at(-1);
  const newestFirst = [...versions].reverse();
  const printed = (v: DesignVersion) => printedAt(p, v) !== undefined;
  return {
    latest,
    /** Every design printed or answered It works, newest first (the newest included: it is printed too). */
    have: newestFirst.filter((v) => printed(v) || v.outcome === "works"),
    /** Sealed designs never printed, newest first, without the newest (the page's own stage). */
    earlier: newestFirst.filter((v) => v.id !== latest?.id && !printed(v) && v.outcome !== "works"),
    /** A project with one design reads exactly as before: no sections. */
    showsSections: versions.length > 1,
    printedLine: (v: DesignVersion) => printedLine(p, v, timeZone),
    outcomeLine: (v: DesignVersion) => outcomeLine(p, v),
    label: (v: DesignVersion) => designLabel(v, timeZone),
  };
}

export function printedLine(p: Project, version: DesignVersion, timeZone?: string): string {
  const at = printedAt(p, version);
  if (at === undefined) {
    if (version.outcome === "works") return "Printed";
    // Never "not printed" for a design that went to the printer: say what is known (#616, the hanger's Nov 4 design).
    const tries = attempts(p, version).length, unknown = unknownEnds(p, version);
    if (unknown > 0)
      return `Sent to the printer ${tries === 1 ? "once" : `${tries} times`} · how ${tries === 1 ? "it" : "they"} ended wasn’t kept`;
    if (tries > 0) return `Not printed · ${tries === 1 ? "1 try" : `${tries} tries`} didn’t finish`;
    return "Not printed yet";
  }
  const printer = attempts(p, version).filter((attempt) => attempt.monitor?.endState === "done").at(-1)?.destination?.name;
  return [`Printed ${designDate(at, timeZone)}`, printer].filter(Boolean).join(" · ");
}

export function outcomeLine(p: Project, version: DesignVersion): string {
  if (version.outcome === "works") return "It works";
  if (version.outcome === "needs-changes") return "Needs changes";
  return printedAt(p, version) === undefined ? "Ready to print" : "Did it fit?";
}

const RUNNING_OR_WAITING = ["new", "touching-up", "needs-closeup", "printing", "failed", "sent", "confirmed", "printed"];
/**
 * The one case the list line changes (DESIGN.md §3.1): the newest design is unprinted and unanswered while an earlier
 * one was printed. Every other project keeps today's words; Done stays Done. A companion that knows designs writes this
 * line itself (`status.text`); this is only for a project whose companion wrote none.
 */
export function twoTruthsLine(p: Project, timeZone?: string): string | undefined {
  const versions = p.versions ?? [];
  const latest = versions.at(-1);
  if (!latest || versions.length < 2 || latest.outcome !== undefined || printedAt(p, latest) !== undefined) return undefined;
  if (RUNNING_OR_WAITING.includes(p.state)) return undefined;
  const earlier = versions.slice(0, -1).map((v) => printedAt(p, v)).filter((at): at is number => at !== undefined);
  return earlier.length ? `New one ready · printed ${designDate(Math.max(...earlier), timeZone)}` : undefined;
}

/** Activity's mark on the pass that sealed a design: "This became the Nov 4 design" (only with two or more designs). */
export function sealedLine(p: Project, passStartedAtMs: number, timeZone?: string): string | undefined {
  if ((p.versions?.length ?? 0) < 2) return undefined;
  const version = p.versions!.find((v) => v.passStartedAtMs === passStartedAtMs);
  return version ? `This became the ${designDate(version.sealedAtMs, timeZone)} design` : undefined;
}

/**
 * A view of one sealed design for the existing stage and header (Kit `Project.showingDesign`). It never goes back to
 * the companion. An unknown id, or none, is the project as it is.
 */
export function showingDesign(p: Project, id: string | undefined): Project {
  const version = id ? p.versions?.find((v) => v.id === id) : undefined;
  if (!version) return p;
  const tried = attempts(p, version);
  const last = tried.at(-1);
  const printed = printedAt(p, version) !== undefined;
  return {
    ...p,
    current: version.result,
    picture: version.picture,
    pictures: version.pictures,
    pictureStates: version.pictureStates,
    outcome: version.outcome,
    status: undefined,
    progress: undefined,
    versions: [version],
    prints: tried,
    print: last
      ? { destination: last.destination, spools: last.spools, monitor: last.monitor ? { ...last.monitor, phase: last.monitor.phase ?? "ended" } : undefined }
      : undefined,
    state: version.outcome === "works" ? "confirmed" : printed ? "printed" : unknownEnds(p, version) > 0 ? "sent" : "ready",
    updatedAtMs: version.sealedAtMs,
  };
}

/** The bar over an earlier design on the stage: "Earlier design · Printed Nov 4 · Workshop printer". */
export function viewingLine(p: Project, version: DesignVersion, timeZone?: string): string {
  return `Earlier design · ${printedLine(p, version, timeZone)}`;
}

/** The picture a design's row shows: its own picture, else its first render. Undefined shows the placeholder. */
export function designThumbnail(version: DesignVersion): string | undefined {
  return version.picture ?? version.result.renders[0];
}

/**
 * What was asked and answered in the project this one was made from (#600, Kit `ProjectConversation`): the line that
 * names it ("From “Phone mount”", with ", since deleted" once it is gone) and its entries, read-only, in time order.
 */
export interface InheritedEntry {
  id: string;
  role: "person" | "counterpart";
  text: string;
  atMs: number;
  /** Shown when more than an hour passed since the previous entry (and on the first). */
  showsTime: boolean;
}
export function inheritedConversation(p: Project, projects: Project[]) {
  const history = p.inherited;
  if (!history) return undefined;
  const live = projects.find((x) => x.id === history.from.id);
  const from = { id: history.from.id, title: live?.title || history.from.title, exists: !!live };
  let previous: number | undefined;
  const entries: InheritedEntry[] = history.items.map((item, index) => {
    const showsTime = previous === undefined || item.at - previous > 3_600_000;
    previous = item.at;
    return { id: `inherited-${index}`, role: item.who === "you" ? "person" : "counterpart", text: item.text, atMs: item.at, showsTime };
  });
  return { from, line: `From “${from.title}”${from.exists ? "" : ", since deleted"}`, entries };
}

/**
 * An earlier design's own Did it fit? (`objects.settings.set` with `versionId`, docs/protocols/objects-api.md): the
 * answer goes to that sealed design only; the project's own status stays as it is.
 */
export function designAnswer(p: Pick<Project, "id">, versionId: string, status: "works" | "needs-changes") {
  return { id: p.id, status, versionId };
}
