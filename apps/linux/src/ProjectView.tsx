import { useEffect, useRef, useState, type ReactNode } from "react";
import { artifact, call, importFiles, openLink, openProject } from "./bridge";
import {
  AFTER_PRINTING,
  activePrint,
  askCaption,
  KNOWN_ASK_KINDS,
  sizeFields,
  sizesAnswer,
  sizeSource,
  sizesUnchanged,
  canSelectPlate,
  clampRegion,
  projectThumbnail,
  scanSample,
  scanWords,
  didItFitQuestion,
  duration,
  passHeading,
  requestedChange,
  stageMark,
  words,
} from "./domain";
import { Picture, Stage } from "./Stage";
import { Question } from "./Question";
import { PrintSheet } from "./PrintSheet";
import { ReconstructionReviewCard } from "./ReconstructionReview";
import { Action, Modal } from "./ui";
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
  // A size question's fields, prefilled once per question; what is sent is `sizesAnswer`'s rule.
  const [fields, setFields] = useState(() => sizeFields(ask));
  const sizes = fields && sizesAnswer(fields);
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
                <small> {sizeSource(field.from)}</small>
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
                sizes,
                ...(text.trim() ? { text: text.trim() } : {}),
                ...(photos.length ? { photoNames: photos } : {}),
              })
            }
          >
            {sizesUnchanged(fields) ? "Confirm these sizes" : "Send these sizes"}
          </Action>
        </div>
      )}
      {ask.kind && !KNOWN_ASK_KINDS.includes(ask.kind) && (
        <p className="hint">Update Counterpart on this computer to answer this kind of question here.</p>
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
      {(text.trim() || photos.length > 0) && (
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
export function ProjectView({
  project: p,
  printers,
  apply,
  mutate,
  onBack,
  changes,
}: {
  project: Project;
  printers: Printer[];
  apply: (p: Project) => void;
  mutate: Mutate;
  onBack: () => void;
  changes: ReturnType<typeof useChangeQueue>;
}) {
  const [tab, setTab] = useState("Request");
  const [note, setNote] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [print, setPrint] = useState(false);
  const [settings, setSettings] = useState(false);
  const [camera, setCamera] = useState(false);
  const [stop, setStop] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<
    Record<
      number,
      { atMs: number; kind: string; text?: string; tool?: string }[]
    >
  >({});
  const queue = changes.queue.filter((q) => q.projectId === p.id);
  const active = p.state === "touching-up" || p.state === "printing";
  const destination = printers.find(
    (x) => x.id === (p.print?.destinationId ?? p.printerDestinationId),
  );
  const fit = didItFitQuestion(p);

  return (
    <>
      <header>
        <div>
          <button className="back" onClick={onBack}>
            ‹ Projects
          </button>
          <h1>{p.title}</h1>
          <p className={`status ${p.status?.tint ?? ""}`}>{words(p)}</p>
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
          <Stage project={p} />
          {fit && (
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
            <ReconstructionReviewCard
              key={p.reconstructionReview.id}
              project={p}
              review={p.reconstructionReview}
              mutate={mutate}
              apply={apply}
            />
          )}
          {p.current?.summary && (
            <p className="result-summary">{p.current.summary}</p>
          )}
          {p.current?.changes && (
            <div className="changes">
              {p.current.changes.map((c, i) => (
                <p key={i}>
                  <span>{c.tag}</span>
                  {c.text}
                </p>
              ))}
            </div>
          )}
          {p.plates && p.plates.length > 0 && (
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
                    aria-label={`${plate.name}, ${plate.status}${plate.selected ? ", selected" : ""}`}
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
                    <span>{plate.status}</span>
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
          )}
          <footer className="project-bar">
            <button
              onClick={() => document.getElementById("changes-note")?.focus()}
            >
              Ask for changes…
            </button>
            {p.state === "new" && (
              <Action
                className="primary"
                run={() => mutate("objects.start", { id: p.id })}
              >
                Start making
              </Action>
            )}
            {p.state === "failed" && (
              <Action run={() => mutate("objects.start", { id: p.id })}>
                Try again
              </Action>
            )}
            <button
              className="primary"
              disabled={
                !p.current ||
                active ||
                !!p.reconstructionReview ||
                p.ask?.status === "open"
              }
              onClick={() => setPrint(true)}
            >
              {p.state === "printed" || p.state === "confirmed"
                ? "Print another…"
                : "Print…"}
            </button>
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
            <AskCard
              key={p.ask.id}
              project={p}
              ask={p.ask}
              mutate={mutate}
              apply={apply}
            />
          )}{" "}
          {tab === "Request" && (
            <>
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
                    disabled={!note.trim() || uncertain || !changes.loaded}
                    run={async () => {
                      if (active) {
                        await changes.enqueue(p.id, note.trim(), attached);
                        setNote("");
                        setAttached([]);
                        return;
                      }
                      try {
                        await mutate("objects.correct", {
                          id: p.id,
                          note: note.trim(),
                          photoNames: attached,
                        });
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
                          <Action run={() => changes.retry(q.id)}>
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
