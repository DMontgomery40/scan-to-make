import { useEffect, useRef, useState, type ReactNode } from "react";
import { artifact, call, importFiles, openLink, openProject } from "./bridge";
import {
  resolvedPrinter,
  AFTER_PRINTING,
  activePrint,
  askCaption,
  askAnswerable,
  sizesCarried,
  sizeFields,
  sizesParams,
  sizeSource,
  sizesUnchanged,
  canSelectPlate,
  clampRegion,
  projectThumbnail,
  scanSample,
  scanWords,
  duration,
  passHeading,
  projectPage,
  requestedChange,
  stageMark,
  words,
  MAKE_FROM_SCAN,
  canMakeFromScan,
  scanLineage,
  plateStatusText,
  DRAFT_LINE,
  DRAFT_COLLAPSE_AFTER,
  draftReasons,
} from "./domain";
import { Picture, Stage } from "./Stage";
import { NEWEST_WAITS, earlierOnStage, designAnswer, designHistory, designDate, designThumbnail, inheritedConversation, sealedLine, showingDesign, viewingLine } from "./designs";
import { Question } from "./Question";
import { PrintSheet } from "./PrintSheet";
import { ReconstructionReviewCard } from "./ReconstructionReview";
import { Action, Modal } from "./ui";
import { noteAttempt, type NoteAttempt } from "./queue";
import type { useChangeQueue } from "./useChangeQueue";
import type { Project, Printer, Ask } from "./types";
type Mutate = (
  method: string,
  params?: object,
) => Promise<{ object?: Project }>;
/** The question's picture (David, Nov 9: "the area it's highlighting is almost impossible to see"): the panel's width at
 * the photo's own aspect ratio, the rest dimmed and the region outlined, sized to the image itself so the region sits on
 * the part it names. Click opens it in a dialog where the wheel or a pinch zooms it. */
function AskPhoto({ project, ask }: { project: Project; ask: Ask }) {
  const [open, setOpen] = useState(false);
  const path = ask.photo ?? projectThumbnail(project);
  const region = ask.photo ? clampRegion(ask.region) : undefined;
  const caption = askCaption(ask);
  // A picture that fails to load hides the whole figure; a new question starts over (review F2, F3 on #456).
  const [failedPath, setFailedPath] = useState<string>();
  if (!path || failedPath === `${project.id}/${path}`) return null;
  const marked = (zoom = 1) => (
    <span className="ask-photo-frame" style={zoom === 1 ? undefined : { transform: `scale(${zoom})` }}>
      <Picture id={project.id} path={path} alt={caption} onFailed={() => setFailedPath(`${project.id}/${path}`)} />
      {region && (
        <span
          className="region"
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.width * 100}%`,
            height: `${region.height * 100}%`,
          }}
        />
      )}
    </span>
  );
  return (
    <figure className="ask-photo">
      <button className="ask-photo-open" aria-label={`${caption} Open it larger.`} onClick={() => setOpen(true)}>
        {marked()}
      </button>
      <figcaption>{caption}</figcaption>
      {open && <ZoomDialog caption={caption} onClose={() => setOpen(false)} render={marked} />}
    </figure>
  );
}
function ZoomDialog({ caption, onClose, render }: { caption: string; onClose: () => void; render: (zoom: number) => ReactNode }) {
  const [zoom, setZoom] = useState(1);
  return (
    <Modal title="The question's picture" onClose={onClose} wide>
      <div
        className="zoom-view"
        onWheel={(e) => setZoom((z) => Math.min(6, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
        onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 3))}
      >
        {render(zoom)}
      </div>
      <p className="ask-caption">{caption} Scroll or pinch to zoom; double-click to zoom in or out.</p>
    </Modal>
  );
}
/** A picture fetched only once it scrolls into view. */
function LazyPicture({ id, path, alt }: { id: string; path: string; alt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return <div ref={ref} className="lazy-picture">{seen ? <Picture id={id} path={path} alt={alt} /> : null}</div>;
}
/**
 * Under What you scanned (design §3.3): Make something else from this scan, on any project the companion has a scan
 * for, whatever its kind; where this one's scan came from; and what else was made from it. Names open their projects.
 */
function ScanLineageRow({ project, projects, onOpen, onMake }: {
  project: Project; projects: Project[]; onOpen?: (id: string) => void; onMake?: (p: Project) => void;
}) {
  const lineage = scanLineage(project, projects);
  if (!canMakeFromScan(project) && !lineage.fromLine && !lineage.madeLine) return null;
  return (
    <div className="scan-lineage">
      {canMakeFromScan(project) && onMake && (
        <button className="primary-outline" onClick={() => onMake(project)}>{MAKE_FROM_SCAN}</button>
      )}
      {lineage.fromLine && (lineage.from?.exists && onOpen
        ? <button className="link" onClick={() => onOpen(lineage.from!.id)}>{lineage.fromLine}</button>
        : <p className="muted">{lineage.fromLine}</p>)}
      {lineage.madeLine && (
        <p className="muted">
          {lineage.made.length === 1 && onOpen
            ? <button className="link" onClick={() => onOpen(lineage.made[0]!.id)}>{lineage.madeLine}</button>
            : <>{lineage.madeLine}{onOpen && lineage.made.map((link) => (
                <button key={link.id} className="link" onClick={() => onOpen(link.id)}> “{link.title}”</button>))}</>}
        </p>
      )}
    </div>
  );
}
/** A scan as one thing (David, Nov 9: "highly unnecessary to show every single one of these"): five frames round the
 * orbit and the count; Show all opens every frame, each fetched as it scrolls into view. */
function ScanStrip({ project }: { project: Project }) {
  const [all, setAll] = useState(false);
  const frames = (project.capture ?? []).map((name) => `capture/${name}`);
  if (!frames.length) return null;
  const words = scanWords(frames.length);
  return (
    <div className="scan-strip">
      <button className="scan-strip-frames" aria-label={`Your scan, ${words}. Show all.`} onClick={() => setAll(true)}>
        {scanSample(frames.length).map((i) => (
          <Picture key={frames[i]} id={project.id} path={frames[i]} alt="" />
        ))}
      </button>
      <div className="scan-strip-words">
        <span>Your scan · {words}</span>
        <button className="link" onClick={() => setAll(true)}>Show all</button>
      </div>
      {all && (
        <Modal title={`Your scan · ${words}`} onClose={() => setAll(false)} wide>
          <div className="scan-gallery">
            {frames.map((path, i) => (
              <LazyPicture key={path} id={project.id} path={path} alt={`Photo ${i + 1} of ${frames.length}`} />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
function AskCard({
  project,
  ask,
  mutate,
  apply,
}: {
  project: Project;
  ask: Ask;
  mutate: Mutate;
  apply: (p: Project) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  // A size question's fields, prefilled once per question; what is sent is `sizesParams`'s rule: the numbers, and which ones the person typed.
  const [fields, setFields] = useState(() => sizeFields(ask));
  const sizes = fields && sizesParams(fields);
  // A kind this build doesn't know: the question and the update sentence, and no answer control at all.
  if (!askAnswerable(ask))
    return (
      <section className="question">
        <div className="eyebrow">Needs you</div>
        <h3>{ask.question}</h3>
        <p className="hint" data-testid="ask-update">Update Counterpart on this computer to answer this kind of question here.</p>
      </section>
    );
  return (
    <section className="question">
      <div className="eyebrow">Needs you</div>
      <h3>{ask.question}</h3>
      {ask.type !== "file" && ask.type !== "choice" && (
        <AskPhoto project={project} ask={ask} />
      )}
      {ask.url && (
        <Action run={() => openLink(ask.url!)}>Open designer’s page</Action>
      )}
      {ask.answers.includes("file") && (
        <Action
          run={async () => {
            const result = await importFiles(project.id, "model");
            if (result.object) apply(result.object);
            if (result.errors.length) throw new Error(result.errors.join("\n"));
          }}
        >
          Import original files…
        </Action>
      )}
      {ask.options?.map((option) => (
        <label className="choice" key={option.id}>
          <input
            type={ask.multiple ? "checkbox" : "radio"}
            name={ask.id}
            checked={selected.includes(option.id)}
            onChange={(e) =>
              setSelected(
                ask.multiple
                  ? e.target.checked
                    ? [...selected, option.id]
                    : selected.filter((x) => x !== option.id)
                  : [option.id],
              )
            }
          />
          {option.thumbnail && (
            <Picture
              id={project.id}
              path={option.thumbnail}
              alt={option.label}
            />
          )}
          <span>
            {option.label}
            <small>{option.detail}</small>
          </span>
        </label>
      ))}
      {ask.options && (
        <Action
          className="primary"
          disabled={!selected.length}
          run={() =>
            mutate("objects.answerAsk", {
              id: project.id,
              askId: ask.id,
              choices: selected,
            })
          }
        >
          Use selection
        </Action>
      )}
      {fields && (
        <div className="ask-sizes">
          {fields.map((field, index) => (
            <label className="field ask-size" key={field.id}>
              <span>
                {field.label.charAt(0).toUpperCase() + field.label.slice(1)}
                <small> {sizeSource(field.from, field.product, field.reference)}</small>
              </span>
              <span className="ask-size-input">
                <input
                  inputMode="decimal"
                  aria-label={`${field.label}, millimetres`}
                  data-testid={`ask-size-${field.id}`}
                  value={field.text}
                  onChange={(e) => setFields(fields.map((f, i) => (i === index ? { ...f, text: e.target.value } : f)))}
                />{" "}
                mm
              </span>
            </label>
          ))}
          {!sizes && <p className="hint">Enter each size in millimetres, or leave one empty if you don’t know it.</p>}
          <Action
            className="primary"
            disabled={!sizes}
            run={() =>
              mutate("objects.answerCloseup", {
                id: project.id,
                bestGuess: false,
                ...sizes,
                ...(text.trim() ? { text: text.trim() } : {}),
                ...(photos.length ? { photoNames: photos } : {}),
              })
            }
          >
            {sizesUnchanged(fields) ? "Confirm these sizes" : "Send these sizes"}
          </Action>
        </div>
      )}
      {ask.answers.includes("text") && (
        <label className="field">
          {fields ? "Anything the numbers don’t say" : "Your answer"}
          <textarea
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}
      {(ask.answers.includes("photos") || ask.answers.includes("camera")) && (
        <Action
          run={async () => {
            const result = await importFiles(project.id, "photos", true);
            setPhotos((p) => [...p, ...result.photoNames]);
            if (result.object) apply(result.object);
            if (result.errors.length) throw new Error(result.errors.join("\n"));
          }}
        >
          {fields ? "Add a caliper photo…" : "Add close-up photos…"}{photos.length ? ` (${photos.length})` : ""}
        </Action>
      )}
      {/* On a size card the one send button above carries the numbers, the words and the photos together. This
          second one is only for a person who cleared every number: then the words or photos go alone. */}
      {(text.trim() || photos.length > 0) && (!fields || sizesCarried(fields) === "none") && (
        <Action
          className={fields ? undefined : "primary"}
          run={() =>
            mutate("objects.answerCloseup", {
              id: project.id,
              bestGuess: false,
              ...(text.trim() ? { text: text.trim() } : {}),
              photoNames: photos,
            })
          }
        >
          Send answer
        </Action>
      )}
      {ask.answers.includes("best-guess") && (
        <Action
          run={() =>
            mutate("objects.answerCloseup", { id: project.id, bestGuess: true })
          }
        >
          Use your best guess
        </Action>
      )}
    </section>
  );
}
function Camera({ id }: { id: string }) {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [at, setAt] = useState("");
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      if (!alive) return;
      try {
        if (!document.hidden) {
          const r = await call<{ base64: string; capturedAt: string }>(
            "objects.camera",
            { id },
          );
          if (alive) {
            setFrame(`data:image/jpeg;base64,${r.base64}`);
            setAt(r.capturedAt);
            setError("");
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = setTimeout(next, 2000);
    };
    void next();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <div className="camera">
      {frame && <img src={frame} alt="Current printer camera" />}
      {at && <small>Captured {new Date(at).toLocaleTimeString()}</small>}
      {error && <p className="notice">{error}</p>}
      {!frame && !error && <p>Connecting to camera…</p>}
    </div>
  );
}
/**
 * What you have and Earlier designs (#616 slice 1, Kit `DesignHistoryView`): under the stage, only with two or more
 * designs. A row shows that design on the same stage; a printed design that has no answer asks its own Did it fit?.
 */
function DesignHistorySection({ project, viewing, select, answer }: {
  project: Project;
  viewing?: string;
  select: (id: string) => void;
  answer: (versionId: string, status: "works" | "needs-changes") => Promise<unknown>;
}) {
  const history = designHistory(project);
  if (!history.showsSections) return null;
  return (
    <section className="designs" aria-label="Designs" data-testid="design-history">
      {history.have.length > 0 && <h3>What you have</h3>}
      {history.have.map((version) => (
        <div className="design-card" key={version.id}>
          <button className="design-row" data-testid={`design-${version.id}`} aria-pressed={viewing === version.id} onClick={() => select(version.id)}>
            <Picture id={project.id} path={designThumbnail(version)} alt="" className="design-thumb" loadingText="…" />
            <span className="design-words">
              <strong>{history.printedLine(version)}</strong>
              <span>{history.label(version)}</span>
              <small>{version.outcome === "works" ? "✓ " : ""}{history.outcomeLine(version)}</small>
            </span>
            <span aria-hidden="true" className="chevron">›</span>
          </button>
          {version.outcome === undefined && (
            <div className="actions">
              <Action run={() => answer(version.id, "works")}>It works</Action>
              <Action run={() => answer(version.id, "needs-changes")}>Needs changes</Action>
            </div>
          )}
        </div>
      ))}
      {history.earlier.length > 0 && <h3>Earlier designs</h3>}
      {history.earlier.map((version) => (
        <button key={version.id} className="design-row earlier" data-testid={`design-${version.id}`} aria-pressed={viewing === version.id} onClick={() => select(version.id)}>
          <span className="muted design-date">{designDate(version.sealedAtMs)}</span>
          <span className="design-words">
            <span>{history.label(version)}</span>
            {/* A design that went to the printer says so, even when how it ended wasn't kept. */}
            {(project.prints ?? []).some((attempt) => attempt.versionId === version.id) && <small>{history.printedLine(version)}</small>}
          </span>
          <span aria-hidden="true" className="chevron">›</span>
        </button>
      ))}
      {project.historyRestored && <p className="muted design-restored">{project.historyRestored}</p>}
    </section>
  );
}
/** The project this one was made from, read-only above its own request (#600, #613; Kit `ProjectConversation`). */
function InheritedHistoryView({ project, projects, onOpen }: { project: Project; projects: Project[]; onOpen?: (id: string) => void }) {
  const history = inheritedConversation(project, projects);
  if (!history) return null;
  return (
    <div className="inherited" data-testid="inherited-history">
      {history.from.exists && onOpen
        ? <button className="link" onClick={() => onOpen(history.from.id)}>{history.line}</button>
        : <p className="muted">{history.line}</p>}
      {history.entries.map((entry) => (
        <div key={entry.id} className={`bubble ${entry.role === "person" ? "user" : "assistant"}`}>
          {entry.showsTime && <small>{new Date(entry.atMs).toLocaleString()}</small>}
          <p>{entry.text}</p>
        </div>
      ))}
      <hr />
    </div>
  );
}
/** The project page; which design is on the stage is its own state (#616: undefined is the newest). */
export function ProjectView(props: Omit<Parameters<typeof ProjectPage>[0], "viewing" | "onView">) {
  const [viewing, setViewing] = useState<string>();
  useEffect(() => setViewing(undefined), [props.project.id]);
  return <ProjectPage {...props} viewing={viewing} onView={setViewing} />;
}
export function ProjectPage({
  viewing,
  onView: setViewing,
  project: p,
  printers,
  apply,
  mutate,
  onBack,
  changes,
  capabilities,
  projects = [],
  onOpenProject,
  onMakeFromScan,
}: {
  /** Every project, for where this one's scan came from and what else was made from it (design §3.3). */
  projects?: Project[];
  onOpenProject?: (id: string) => void;
  /** New, holding this project's scan: "Make something else from this scan". */
  onMakeFromScan?: (p: Project) => void;
  /** The earlier design on the stage (#616); undefined is the newest. */
  viewing?: string;
  onView: (id: string | undefined) => void;
  /** The companion's capabilities (`status.get`): what it keeps decides what the page offers. */
  capabilities?: Record<string, unknown>;
  project: Project;
  printers: Printer[];
  apply: (p: Project) => void;
  mutate: Mutate;
  onBack: () => void;
  changes: ReturnType<typeof useChangeQueue>;
}) {
  const [tab, setTab] = useState("Request");
  // An earlier design on the stage (#616): every send and answer for the newest waits until it is shown again, as the
  // Mac's `blocked` does. The design rows' own It works / Needs changes, and the running print's controls, stay live.
  const earlier = earlierOnStage(p, viewing);
  const shown = earlier ? showingDesign(p, earlier.id) : p;
  const waitNewest = earlier ? NEWEST_WAITS : undefined;
  const waits = !!earlier;
  const [note, setNote] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [print, setPrint] = useState(false);
  const [settings, setSettings] = useState(false);
  const [camera, setCamera] = useState(false);
  const [stop, setStop] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  // This note's id across every try at sending it (queue.ts noteAttempt).
  const attempt = useRef<NoteAttempt | undefined>(undefined);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<
    Record<
      number,
      { atMs: number; kind: string; text?: string; tool?: string }[]
    >
  >({});
  const queue = changes.queue.filter((q) => q.projectId === p.id);
  const active = p.state === "touching-up" || p.state === "printing";
  const { page, fit } = projectPage(p, capabilities);
  const destination = resolvedPrinter(printers, p.print?.destinationId ?? p.printerDestinationId);

  return (
    <>
      <header>
        <div>
          <button className="back" onClick={onBack}>
            ‹ Projects
          </button>
          <h1>{p.title}</h1>
          <p className={`status ${earlier ? "" : p.status?.tint ?? ""}`}>{words(shown)}</p>
        </div>
        <div className="toolbar">
          <Action run={() => openProject(p.id, "folder")}>Files</Action>
          <select
            aria-label="Open in a modeling app"
            value=""
            onChange={(e) => {
              const value = e.target.value as
                "blender" | "bambu-studio" | "orca";
              void openProject(p.id, value).catch((e) => setError(String(e)));
            }}
          >
            <option value="">Open in…</option>
            <option value="blender">Blender</option>
            <option value="bambu-studio">Bambu Studio</option>
            <option value="orca">OrcaSlicer</option>
          </select>
          <button onClick={() => setSettings(true)}>Project settings</button>
        </div>
      </header>
      <div className="project-layout">
        <div className="project-main">
          <Stage key={earlier?.id ?? "newest"} project={shown} locate={earlier ? undefined : () => void mutate("objects.locate", { id: p.id })} />
          {earlier && (
            <div className="viewing-bar" data-testid="viewing-earlier-design">
              <div>
                <small>{viewingLine(p, earlier)}</small>
                <p>{designHistory(p).label(earlier)}</p>
              </div>
              <button onClick={() => setViewing(undefined)}>Show the newest</button>
            </div>
          )}
          <DesignHistorySection project={p} viewing={viewing}
            select={(id) => setViewing(id === p.versions?.at(-1)?.id ? undefined : id)}
            answer={(versionId, status) => mutate("objects.settings.set", designAnswer(p, versionId, status))} />
          <ScanLineageRow project={p} projects={projects} onOpen={onOpenProject} onMake={onMakeFromScan} />
          {fit && !earlier && (
            // After the print (Nov 8 walkthrough F1, PRD §5.4): the same question and answers as the other clients.
            <section className="question" aria-label={fit}>
              <div className="eyebrow">After printing</div>
              <h3>{fit}</h3>
              <p>
                Try it where it goes. Your answer stays with the project on
                this computer.
              </p>
              <div className="actions">
                <Action
                  className="primary"
                  run={() =>
                    mutate("objects.settings.set", { id: p.id, status: "works" })
                  }
                >
                  It Works
                </Action>
                <Action
                  run={async () => {
                    await mutate("objects.settings.set", {
                      id: p.id,
                      status: "needs-changes",
                    });
                    setTab("Request");
                    setNote((n) =>
                      n.startsWith(AFTER_PRINTING) ? n : AFTER_PRINTING + n,
                    );
                    setTimeout(() =>
                      document.getElementById("changes-note")?.focus(),
                    );
                  }}
                >
                  Needs Changes
                </Action>
              </div>
            </section>
          )}
          {p.reconstructionReview && (
            <fieldset className="waits" disabled={waits} title={waitNewest} data-testid="review-wait">
            <ReconstructionReviewCard
              key={p.reconstructionReview.id}
              project={p}
              review={p.reconstructionReview}
              mutate={mutate}
              apply={apply}
            />
            </fieldset>
          )}
          {shown.current?.draft && <DraftNote draft={shown.current.draft} />}
          {shown.current?.summary && (
            <p className="result-summary">{shown.current.summary}</p>
          )}
          {shown.current?.changes && (
            <div className="changes">
              {shown.current.changes.map((c, i) => (
                <p key={i}>
                  <span>{c.tag}</span>
                  {c.text}
                </p>
              ))}
            </div>
          )}
          {p.plates && p.plates.length > 0 && (
            <fieldset className="waits" disabled={waits} title={waitNewest} data-testid="plates-wait">
            <section className="plates">
              <h3>
                {p.plates.filter((x) => x.status === "printed").length} of{" "}
                {p.plates.length} plates printed
              </h3>
              <div>
                {p.plates.map((plate) => (
                  <button
                    key={plate.id}
                    className={plate.selected ? "plate selected" : "plate"}
                    disabled={!canSelectPlate(p)}
                    aria-pressed={plate.selected}
                    aria-label={`${plate.name}, ${plateStatusText(plate)}${plate.selected ? ", selected" : ""}`}
                    onClick={() =>
                      void mutate("objects.selectPlate", {
                        id: p.id,
                        fileIndex: plate.fileIndex,
                        plateIndex: plate.plateIndex,
                      }).catch((e) => setError(String(e)))
                    }
                  >
                    <Picture
                      id={p.id}
                      path={plate.thumbnail}
                      alt={plate.name}
                    />
                    <strong>{plate.name}</strong>
                    <small>{plate.fileName}</small>
                    <span>{plateStatusText(plate)}</span>
                  </button>
                ))}
              </div>
              <Action
                // Marking it settles a send Counterpart couldn't confirm, so only a running print holds it.
                disabled={p.state === "printing"}
                run={() =>
                  mutate("objects.settings.set", {
                    id: p.id,
                    status:
                      p.plates?.find((x) => x.selected)?.status === "printed"
                        ? "not-printed"
                        : "printed",
                  })
                }
              >
                {p.plates.find((x) => x.selected)?.status === "printed"
                  ? "Mark selected plate not printed"
                  : "Mark selected plate printed"}
              </Action>
              <Action
                disabled={activePrint(p)}
                run={async () => {
                  const r = await importFiles(p.id, "model");
                  if (r.object) apply(r.object);
                  if (r.errors.length) throw new Error(r.errors.join("\n"));
                }}
              >
                Add original files…
              </Action>
            </section>
            </fieldset>
          )}
          <footer className="project-bar">
            <button
              disabled={!!earlier}
              title={waitNewest}
              onClick={() => document.getElementById("changes-note")?.focus()}
            >
              Ask for changes…
            </button>
            {p.state === "new" && (
              <Action
                className="primary"
                disabled={!!earlier}
                run={() => mutate("objects.start", { id: p.id })}
              >
                Start making
              </Action>
            )}
            {/* One filled control, the page's main action (`pageActions`): Try again when a pass stopped; Print
                only when it leads. Printing is named for what it would print, and offered once. */}
            {page.main === "retry" && (
              <Action className="primary" disabled={!!earlier} run={() => mutate("objects.start", { id: p.id })}>
                Try again
              </Action>
            )}
            {page.printWords && (
              <button
                className={page.main === "print" ? "primary" : undefined}
                title={waitNewest ?? page.printNote}
                data-testid="print"
                disabled={!!earlier || !!p.reconstructionReview || p.ask?.status === "open"}
                onClick={() => setPrint(true)}
              >
                {page.printWords}…
              </button>
            )}
          </footer>
        </div>
        <aside className="inspector">
          <div className="tabs" role="tablist">
            {["Request", "Activity", "Print"].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={t === tab}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {p.failure && <p className="error">{p.failure}</p>}
          {!p.reconstructionReview && p.ask?.status === "open" && (
            <fieldset className="waits" disabled={waits} title={waitNewest} data-testid="ask-wait">
            <AskCard
              key={p.ask.id}
              project={p}
              ask={p.ask}
              mutate={mutate}
              apply={apply}
            />
            </fieldset>
          )}{" "}
          {tab === "Request" && (
            <>
              <InheritedHistoryView project={p} projects={projects} onOpen={onOpenProject} />
              <div className="conversation">
                <div className="bubble user">
                  <p>{p.instructions || "A new project"}</p>
                  {p.requestPhotos?.map((name) => (
                    <Picture
                      key={name}
                      id={p.id}
                      path={`photos/${name}`}
                      alt="Photo with original request"
                    />
                  ))}
                  <ScanStrip project={p} />
                </div>
                {[
                  ...p.passes.map((pass, index) => ({
                    at: pass.startedAtMs,
                    key: `pass-${index}`,
                    pass,
                  })),
                  ...(p.messages ?? []).map((message) => ({
                    at: message.atMs,
                    key: message.id,
                    message,
                  })),
                ]
                  .sort((a, b) => a.at - b.at)
                  .map((item) =>
                    "pass" in item ? (
                      <div key={item.key}>
                        {item.pass.note &&
                          !p.messages?.some(
                            (m) =>
                              m.id ===
                              (item.pass as { messageId?: string }).messageId,
                          ) && (
                            <div className="bubble user">
                              <p>{item.pass.note}</p>
                              {item.pass.photos?.map((name) => (
                                <Picture
                                  key={name}
                                  id={p.id}
                                  path={`photos/${name}`}
                                  alt="Photo with this request"
                                />
                              ))}
                            </div>
                          )}
                        <div className="bubble assistant">
                          <small>{new Date(item.at).toLocaleString()}</small>
                          <p>
                            {item.pass.summary ??
                              item.pass.stages?.find((s) => !s.endedAtMs)
                                ?.words ??
                              item.pass.words ??
                              "Working…"}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="bubble user" key={item.key}>
                        <p>{item.message.text}</p>
                        {item.message.photos.map((name) => (
                          <Picture
                            key={name}
                            id={p.id}
                            path={`photos/${name}`}
                            alt="Photo with this message"
                          />
                        ))}
                      </div>
                    ),
                  )}
              </div>
              {p.pendingFollowup && (
                <div className="notice">
                  <p>Saved for your review: {p.pendingFollowup}</p>
                  <Action
                    disabled={waits}
                    run={() =>
                      mutate("objects.correct", {
                        id: p.id,
                        note: p.pendingFollowup,
                      })
                    }
                  >
                    Retry saved request
                  </Action>
                </div>
              )}
              {p.credit && (
                <div className="credit">
                  <strong>{p.credit.title}</strong>
                  <p>
                    By {p.credit.designer ?? "the original designer"} ·{" "}
                    {p.credit.site}
                  </p>
                  <small>{p.credit.licence}</small>
                  <Action run={() => openLink(p.credit!.url)}>
                    Designer’s page ↗
                  </Action>
                </div>
              )}
              <div className="composer">
                {changes.error && (
                  <p role="alert" className="error">
                    {changes.error}
                  </p>
                )}
                <label className="field">
                  Ask for changes
                  <textarea
                    id="changes-note"
                    maxLength={4000}
                    value={note}
                    placeholder="What would you like to change?"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <Action
                    run={async () => {
                      const r = await importFiles(p.id, "photos", true);
                      setAttached((a) => [...a, ...r.photoNames]);
                      if (r.object) apply(r.object);
                      if (r.errors.length) throw new Error(r.errors.join("\n"));
                    }}
                  >
                    Photos{attached.length ? ` (${attached.length})` : ""}…
                  </Action>
                  <Action
                    className="primary"
                    disabled={!!earlier || !note.trim() || uncertain || !changes.loaded}
                    run={async () => {
                      if (active) {
                        await changes.enqueue(p.id, note.trim(), attached);
                        setNote("");
                        setAttached([]);
                        return;
                      }
                      try {
                        const sending = noteAttempt(attempt.current, note.trim(), attached);
                        attempt.current = sending;
                        await mutate("objects.correct", {
                          id: p.id,
                          note: note.trim(),
                          photoNames: attached,
                          messageId: sending.id,
                        });
                        attempt.current = undefined;
                        setNote("");
                        setAttached([]);
                      } catch (e) {
                        setUncertain(true);
                        throw e;
                      }
                    }}
                  >
                    {active ? "Queue change" : "Send"}
                  </Action>
                </div>
                {waitNewest && <p className="hint">{waitNewest}</p>}
                {queue.length > 0 && (
                  <div className="notice">
                    Saved changes wait until this project is ready.
                    {queue.map((q) => (
                      <div key={q.id}>
                        <p>
                          {q.note} · {q.state}
                        </p>
                        {q.error && <p>{q.error}</p>}
                        <Action
                          run={() => changes.discard(q.id)}
                          disabled={q.state === "sending"}
                        >
                          Discard
                        </Action>
                        {q.state === "uncertain" && (
                          <Action disabled={waits} run={() => changes.retry(q.id)}>
                            I checked the conversation; retry
                          </Action>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {uncertain && (
                  <div className="notice">
                    The send’s outcome is uncertain. Check the conversation
                    before retrying.
                    <button onClick={() => setUncertain(false)}>
                      I’ve checked; enable sending
                    </button>
                    <button
                      onClick={() => {
                        setNote("");
                        setAttached([]);
                        setUncertain(false);
                      }}
                    >
                      Discard local draft
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === "Activity" && (
            <div className="activity">
              {p.passes.map((pass, i) => (
                <section key={i}>
                  <h3>
                    {passHeading(pass, i)}
                  </h3>
                  {requestedChange(pass) && <p className="hint">Your change: “{requestedChange(pass)}”</p>}
                  {sealedLine(p, pass.startedAtMs) && <p className="hint sealed" data-testid={`pass-${i + 1}-sealed`}>◈ {sealedLine(p, pass.startedAtMs)}</p>}
                  {pass.stages?.map((s, stage) => (
                    <p key={s.id}>
                      {stageMark(pass, stage)} {s.words}
                    </p>
                  ))}
                  <p>{pass.summary}</p>
                  <Action
                    run={async () => {
                      const r = await call<{
                        activity: {
                          atMs: number;
                          kind: string;
                          text?: string;
                          tool?: string;
                        }[];
                      }>("objects.passActivity", { id: p.id, index: i });
                      setActivity((a) => ({ ...a, [i]: r.activity }));
                    }}
                  >
                    Read activity
                    {pass.activityCount ? ` (${pass.activityCount})` : ""}
                  </Action>
                  {activity[i]?.map((a, n) => (
                    <p key={n}>
                      <small>{new Date(a.atMs).toLocaleTimeString()}</small>{" "}
                      {a.text ?? a.tool ?? a.kind}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          )}
          {tab === "Print" && (
            <>
              <h3>
                {p.print?.destination?.name ??
                  destination?.name ??
                  "No print yet"}
              </h3>
              <p>{p.print?.live?.job?.stage ?? words(p)}</p>
              {p.print?.live?.job?.progress !== undefined && (
                <progress value={p.print.live.job.progress} max={100} />
              )}
              <p>
                {p.print?.live?.job?.layer !== undefined
                  ? `Layer ${p.print.live.job.layer} of ${p.print.live.job.totalLayers ?? "?"}`
                  : ""}{" "}
                {p.print?.live?.job?.remainingSec !== undefined
                  ? duration(p.print.live.job.remainingSec) + " left"
                  : ""}
              </p>
              {p.print?.live?.problems.map((problem) => (
                <p className="notice" key={problem.code}>
                  {problem.message}
                </p>
              ))}
              {p.print?.uncertain && (
                <p className="notice">
                  This print may have reached the printer. Counterpart will not
                  send it again automatically.
                </p>
              )}
              {p.print?.monitor?.unreachableSince && (
                <p className="notice">
                  The printer is temporarily unreachable. Its last report is
                  retained.
                </p>
              )}
              <div className="actions">
                {p.state === "printing" &&
                  (p.print?.live?.state === "paused" ? (
                    <Action
                      disabled={destination?.capabilities?.resume !== true}
                      run={() => mutate("objects.resumePrint", { id: p.id })}
                    >
                      Resume
                    </Action>
                  ) : (
                    <Action
                      disabled={destination?.capabilities?.pause !== true}
                      run={() => mutate("objects.pausePrint", { id: p.id })}
                    >
                      Pause
                    </Action>
                  ))}
                {p.state === "printing" && (
                  <button
                    className="danger"
                    disabled={destination?.capabilities?.cancel !== true}
                    onClick={() => setStop(true)}
                  >
                    Stop…
                  </button>
                )}
                <button onClick={() => setCamera(!camera)}>
                  {camera ? "Close camera" : "Show camera"}
                </button>
              </div>
              {camera && <Camera id={p.id} />}
              <div className="activity">
                {p.print?.events?.map((e, i) => (
                  <p key={i}>
                    <small>{new Date(e.atMs).toLocaleTimeString()}</small>{" "}
                    {e.message}
                  </p>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      {print && (
        <PrintSheet
          project={p}
          printers={printers}
          apply={apply}
          onClose={() => setPrint(false)}
        />
      )}{" "}
      {stop && (
        <Modal title="Stop printing?" onClose={() => setStop(false)}>
          <p>The printer will stop this print. You can print it again later.</p>
          <div className="dialog-actions">
            <button onClick={() => setStop(false)}>Keep printing</button>
            <Action
              className="danger"
              run={async () => {
                setStop(false);
                await mutate("objects.cancelPrint", { id: p.id });
              }}
            >
              Stop printing
            </Action>
          </div>
        </Modal>
      )}
      {settings && (
        <ProjectSettings
          project={p}
          mutate={mutate}
          onClose={() => setSettings(false)}
          onDeleted={onBack}
        />
      )}
    </>
  );
}
function ProjectSettings({
  project: p,
  mutate,
  onClose,
  onDeleted,
}: {
  project: Project;
  mutate: Mutate;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(p.title);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [defaults, setDefaults] = useState(p.settings?.printDefaults ?? {});
  return (
    <Modal title="Project settings" onClose={onClose}>
      <label className="field">
        Name
        <input
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <Action run={() => mutate("objects.settings.set", { id: p.id, title })}>
        Save name
      </Action>
      <label className="field">
        Status
        <select
          value={p.settings?.status ?? "not-printed"}
          onChange={(e) =>
            void mutate("objects.settings.set", {
              id: p.id,
              status: e.target.value,
            }).catch((e) => setError(String(e)))
          }
        >
          {["not-printed", "printed", "works", "needs-changes", "archived"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
      </label>
      <label className="field">
        Design engine
        <select
          value={p.settings?.designEngine === "blender" ? "blender" : "auto"}
          onChange={(e) =>
            void mutate("objects.settings.set", {
              id: p.id,
              designEngine: e.target.value,
            }).catch((e) => setError(String(e)))
          }
        >
          <option value="auto">Automatic</option>
          <option value="blender">Blender</option>
        </select>
      </label>
      <p>
        Fusion is unavailable on Linux. Design uses Blender through your printer
        MCP.
      </p>
      <h3>Default print settings</h3>
      <div className="two-columns">
        <label className="field">
          Quality
          <select
            value={defaults.quality ?? "standard"}
            onChange={(e) =>
              setDefaults((d) => ({ ...d, quality: e.target.value }))
            }
          >
            {["draft", "standard", "fine"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Strength
          <select
            value={defaults.strength ?? "standard"}
            onChange={(e) =>
              setDefaults((d) => ({ ...d, strength: e.target.value }))
            }
          >
            {["standard", "strong", "max"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Copies
        <input
          type="number"
          min={1}
          max={64}
          value={defaults.copies ?? 1}
          onChange={(e) =>
            setDefaults((d) => ({ ...d, copies: Number(e.target.value) }))
          }
        />
      </label>
      <Action
        run={() =>
          mutate("objects.settings.set", { id: p.id, printDefaults: defaults })
        }
      >
        Save print defaults
      </Action>
      <label className="field">
        Notifications
        <select
          value={p.settings?.notifications ?? "all"}
          onChange={(e) =>
            void mutate("objects.settings.set", {
              id: p.id,
              notifications: e.target.value,
            }).catch((e) => setError(String(e)))
          }
        >
          <option value="all">All project updates</option>
          <option value="problems">Problems only</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <Action
          run={() =>
            mutate("objects.settings.set", { id: p.id, archived: !p.archived })
          }
        >
          {p.archived ? "Restore to Home" : "Archive"}
        </Action>
        <Action run={() => mutate("objects.duplicate", { id: p.id })}>
          Duplicate
        </Action>
        <button className="danger" onClick={() => setDeleting(true)}>
          Delete…
        </button>
      </div>
      {deleting && (
        <div className="error">
          <p>Delete this project and all of its retained files?</p>
          <Action
            className="danger"
            disabled={activePrint(p)}
            run={async () => {
              await mutate("objects.delete", { id: p.id });
              onClose();
              onDeleted();
            }}
          >
            Delete project
          </Action>
          <button onClick={() => setDeleting(false)}>Keep project</button>
        </div>
      )}
    </Modal>
  );
}

/** #788: a design that isn't finished: the plain line, then the printer MCP's reasons word for word (two, then Show all). */
function DraftNote({ draft }: { draft: { reasons?: string[] } }) {
  const [expanded, setExpanded] = useState(false);
  const all = draftReasons(draft, true), shown = draftReasons(draft, expanded);
  return (
    <section className="notice draft-design" data-testid="draft-design">
      <strong>{DRAFT_LINE}</strong>
      {shown.length > 0 && (
        <ul>
          {shown.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      )}
      {all.length > DRAFT_COLLAPSE_AFTER && (
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${all.length}`}
        </button>
      )}
    </section>
  );
}
