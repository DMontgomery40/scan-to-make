import { useCallback, useEffect, useState } from "react";
import {
  call,
  host,
  importFiles,
  previewFile,
  pickInputs,
  importSelected,
  releaseInputs,
  type PickedInput,
} from "./bridge";
import { ModelStage, Picture } from "./Stage";
import { ProjectView } from "./ProjectView";
import { Settings, Pairing } from "./Settings";
import { Question } from "./Question";
import { Action, Modal } from "./ui";
import { searchProject, startersShown, words } from "./domain";
import { useWorkspace } from "./useWorkspace";
import { useChangeQueue } from "./useChangeQueue";
import type { HostStatus, Project } from "./types";
import catalog from "../shared/catalog.json";
import caliperImage from "../shared/caliper.png";
import vernierImage from "../shared/vernier.png";
export function App() {
  const [status, setStatus] = useState<HostStatus>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [preview, setPreview] = useState<Uint8Array>();
  const [selected, setSelected] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [invitation, setInvitation] = useState<{
    qrPayload: string;
    expiresAt: number;
    code: string;
  }>();
  const workspace = useWorkspace(!!status?.running);
  const changes = useChangeQueue(
    workspace.projects,
    workspace.connected,
    workspace.mutate,
  );
  const current = workspace.projects.find((p) => p.id === selected);
  const closePairing = useCallback(() => setInvitation(undefined), []);
  const pair = async () => setInvitation(await call("pairing.create"));
  const readHost = async () => {
    setChecking(true);
    try {
      setStatus(await host("status"));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void readHost();
  }, []);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        if (status?.running) setCreating(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSelected(undefined);
        setTimeout(() => document.getElementById("project-search")?.focus(), 0);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettings(true);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [status?.running]);
  const open = (p: Project) => {
    workspace.apply(p);
    setSelected(p.id);
  };
  const eligible = workspace.projects.filter(
    (p) =>
      (filter === "archived" ? p.archived : !p.archived) &&
      (filter !== "working" || ["touching-up", "printing"].includes(p.state)),
  );
  const visible = eligible.filter((p) => searchProject(p, search));
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          ◈ <span>Counterpart</span>
        </div>
        <button
          className={`nav ${filter === "all" && !selected ? "selected" : ""}`}
          onClick={() => {
            setSelected(undefined);
            setFilter("all");
            setPreview(undefined);
          }}
        >
          ⌂ Projects
        </button>
        <button
          className={`nav ${filter === "working" ? "selected" : ""}`}
          onClick={() => {
            setSelected(undefined);
            setFilter("working");
          }}
        >
          ◌ In progress{" "}
          <span>
            {workspace.projects.filter(
              (p) => p.state === "printing" || p.state === "touching-up",
            ).length || ""}
          </span>
        </button>
        <button
          className={`nav ${filter === "archived" ? "selected" : ""}`}
          onClick={() => {
            setSelected(undefined);
            setFilter("archived");
          }}
        >
          ▤ Archive
        </button>
        {status?.running && (
          <button className="new-sidebar" onClick={() => setCreating(true)}>
            + New project
          </button>
        )}
        <div className="sidebar-projects">
          {workspace.projects
            .filter((p) => !p.archived)
            .slice(0, 8)
            .map((p) => (
              <button
                key={p.id}
                className={selected === p.id ? "selected" : ""}
                onClick={() => setSelected(p.id)}
              >
                {p.title}
                <small>{words(p)}</small>
              </button>
            ))}
        </div>
        <div className="sidebar-foot">
          {workspace.jobs
            .filter(
              (j) =>
                !["completed", "failed", "cancelled"].includes(
                  j.job.status ?? "",
                ),
            )
            .map((j, i) => (
              <p key={i}>
                {j.projectName ?? j.kind} · {j.job.status}
              </p>
            ))}
          <p>
            <span
              className={`status-dot ${workspace.connected ? "connected" : ""}`}
            />
            {workspace.connected
              ? "Computer connected"
              : status?.running
                ? "Reconnecting…"
                : status?.configured
                  ? "Computer stopped"
                  : "Computer not set up"}
          </p>
          <button className="nav" onClick={() => setSettings(true)}>
            ⚙ Settings
          </button>
          <small>Your work stays on your computer.</small>
        </div>
      </aside>
      <main>
        {preview ? (
          <>
            <header>
              <h1>Model preview</h1>
              <button onClick={() => setPreview(undefined)}>
                Close preview
              </button>
            </header>
            <ModelStage bytes={preview} />
          </>
        ) : !status?.running ? (
          <>
            <header>
              <h1>Welcome to Counterpart</h1>
            </header>
            <section className="welcome">
              <div className="welcome-mark">◈</div>
              <h2>Make things that fit your life.</h2>
              <p>
                Connect your phone, bring an idea or scan, and make it real with
                your printer.
              </p>
              <Action
                className="primary"
                disabled={checking}
                run={async () => {
                  setError("");
                  const next = await host(
                    status?.configured ? "start" : "setup",
                  );
                  setStatus(next);
                  if (!next.running) {
                    setError(
                      "Setup is saved, but the companion has not started. Check again shortly. If it stays stopped, the companion needs attention before projects can connect.",
                    );
                  }
                }}
                onError={setError}
              >
                {status?.configured
                  ? "Start this computer"
                  : "Set up this computer"}
              </Action>
              <Action
                run={async () => {
                  const data = await previewFile();
                  if (data.length) setPreview(data);
                }}
              >
                Preview an STL file…
              </Action>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <Action run={readHost}>Check again</Action>
              {status?.configured && (
                <Action
                  run={async () => {
                    setError("");
                    const next = await host("setup");
                    setStatus(next);
                    if (!next.running)
                      setError(
                        "Setup was repaired, but the companion has not started. Check again shortly.",
                      );
                  }}
                  onError={setError}
                >
                  Repair setup
                </Action>
              )}
              <small>
                Fusion and iCloud project sync are unavailable on Linux. Connect
                over your home network or Tailscale.
              </small>
            </section>
          </>
        ) : selected ? (
          current ? (
            <ProjectView
              key={current.id}
              changes={changes}
              project={current}
              printers={workspace.printers}
              apply={workspace.apply}
              mutate={workspace.mutate}
              onBack={() => setSelected(undefined)}
            />
          ) : (
            <section className="welcome">
              <h2>Project unavailable</h2>
              <p>
                {workspace.connected
                  ? "This project was removed or is no longer available."
                  : "Waiting for this computer to reconnect."}
              </p>
              <button onClick={() => setSelected(undefined)}>
                Back to projects
              </button>
            </section>
          )
        ) : (
          <>
            <header>
              <div>
                <h1>
                  {filter === "archived"
                    ? "Archive"
                    : filter === "working"
                      ? "In progress"
                      : "Projects"}
                </h1>
                <p>
                  {workspace.connected
                    ? "This computer is connected"
                    : "Connecting to this computer"}{" "}
                  ·{" "}
                  {workspace.printers.filter((p) => p.state === "ready").length}{" "}
                  printers ready
                </p>
              </div>
              <div className="toolbar">
                <Action run={pair}>Add a phone…</Action>
                <button className="primary" onClick={() => setCreating(true)}>
                  + New project
                </button>
              </div>
            </header>
            <section className="home">
              <div className="home-tools">
                <input
                  id="project-search"
                  type="search"
                  aria-label="Search projects and conversations"
                  placeholder="Search projects, requests, and notes"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Action run={workspace.refresh}>Refresh</Action>
                {visible.length < eligible.length && (
                  <div role="status" className="search-summary">
                    <span>{visible.length} of {eligible.length} projects match “{search}”</span>
                    <button onClick={() => setSearch("")}>Show All</button>
                  </div>
                )}
              </div>
              {workspace.error && (
                <p role="alert" className="notice">
                  {workspace.error} Existing work is retained. Requests are
                  never replayed automatically.
                </p>
              )}
              {workspace.eventNotice && (
                <p role="status" className="notice">
                  {workspace.eventNotice}
                </p>
              )}
              <div className="project-grid">
                {visible.map((p) => (
                  <button
                    className="project-card"
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                  >
                    <Picture
                      id={p.id}
                      path={p.current?.renders[0] ?? p.credit?.thumbnail}
                      alt={p.title}
                    />
                    <div>
                      <h3>{p.title}</h3>
                      <p>{words(p)}</p>
                    </div>
                  </button>
                ))}
              </div>
              {visible.length === 0 && (
                <div className="empty">
                  <h2>
                    {search
                      ? "No matching projects"
                      : filter === "all"
                        ? "What will you make?"
                        : "Nothing here yet"}
                  </h2>
                  <p>
                    {search
                      ? "Search includes the conversation and notes."
                      : "Start with an idea, a scan from your phone, or an original model file."}
                  </p>
                </div>
              )}
              {startersShown({ search, filter }) && (
                <>
                  <div className="section-head">
                    <div>
                      <h2>A little help getting started</h2>
                      <p>Useful tools for better scans and a better fit.</p>
                    </div>
                  </div>
                  <div className="starter-grid">
                    {catalog.map((starter) => (
                      <article className="starter" key={starter.id}>
                        {starter.id === "caliper-card" ? (
                          <img
                            src={caliperImage}
                            alt="Counterpart caliper card"
                          />
                        ) : starter.id === "long-vernier-caliper" ? (
                          <img src={vernierImage} alt="Long vernier caliper" />
                        ) : (
                          <div className="starter-symbol" aria-hidden>
                            ◎
                          </div>
                        )}
                        <div>
                          <h3>{starter.title}</h3>
                          <p>{starter.summary}</p>
                          <small>
                            {starter.detail} · {starter.designer}
                          </small>
                          <Action
                            run={async () => {
                              const r = await workspace.mutate(
                                "objects.addStarter",
                                { starterId: starter.id },
                              );
                              if (r.object) open(r.object);
                            }}
                          >
                            Start this project
                          </Action>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </main>
      {settings && (
        <Settings
          printers={workspace.printers}
          onClose={() => {
            setSettings(false);
            void readHost();
          }}
          onRefresh={workspace.refresh}
          onPair={pair}
        />
      )}{" "}
      {creating && (
        <NewProject
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            open(p);
            setCreating(false);
          }}
        />
      )}
      {invitation && <Pairing invitation={invitation} onClose={closePairing} />}{" "}
      {(workspace.questions[0] ||
        workspace.projects.some((p) => p.printConfirmation)) && (
        <ConfirmationInbox
          question={workspace.questions[0]}
          project={workspace.projects.find((p) => p.printConfirmation)}
          mutate={workspace.mutate}
        />
      )}
    </div>
  );
}
function NewProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState("fit");
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState<Project>();
  const [inputs, setInputs] = useState<PickedInput[]>([]);
  const [error, setError] = useState("");
  const create = async () => {
    if (draft) return draft;
    const { object } = await call<{ object: Project }>("objects.create", {
      instructions,
      kind,
      ...(kind === "published" ? { url } : {}),
    });
    setDraft(object);
    if (inputs.length) {
      const tokens = inputs.map((i) => i.token);
      setInputs([]);
      const imported = await importSelected(object.id, tokens);
      if (imported.object) setDraft(imported.object);
      if (imported.errors.length) throw new Error(imported.errors.join("\n"));
      return imported.object ?? object;
    }
    return object;
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <div className="segmented">
        {[
          ["fit", "Make something that fits"],
          ["copy", "Copy an object"],
          ["published", "Print a published model"],
        ].map(([v, l]) => (
          <button
            key={v}
            disabled={!!draft}
            aria-pressed={kind === v}
            onClick={() => setKind(v)}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="field">
        What do you need?
        <textarea
          autoFocus
          value={instructions}
          disabled={!!draft}
          maxLength={8000}
          placeholder="Describe it, scan it, or both. Your computer can look up published sizes."
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {kind === "published" && (
        <label className="field">
          Designer’s model page
          <input
            type="url"
            value={url}
            disabled={!!draft}
            placeholder="https://makerworld.com/…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      )}
      <p className="muted">
        Photos and originals stay with this project. Use your paired phone to
        scan an object.
      </p>
      <div className="actions">
        {(["photos", "model", "scan"] as const).map((k) => (
          <Action
            key={k}
            disabled={kind === "published" && !url}
            onError={setError}
            run={async () => {
              if (draft) {
                const r = await importFiles(draft.id, k);
                if (r.object) setDraft(r.object);
                if (r.errors.length) throw new Error(r.errors.join("\n"));
              } else {
                const picked = await pickInputs(k);
                setInputs((all) => [...all, ...picked]);
              }
            }}
          >
            Add {k === "model" ? "originals" : k}…
          </Action>
        ))}
      </div>
      {inputs.length > 0 && (
        <div className="selected-inputs">
          {inputs.map((i) => (
            <p key={i.token}>
              {i.name}{" "}
              <button
                onClick={() => {
                  void releaseInputs([i.token]);
                  setInputs((all) => all.filter((x) => x.token !== i.token));
                }}
              >
                Remove
              </button>
            </p>
          ))}
        </div>
      )}
      {draft && (
        <p>
          {draft.photos.length} photos · {draft.files?.original.length ?? 0}{" "}
          original files. Draft saved.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>
          {draft ? "Keep draft & close" : "Cancel"}
        </button>
        <Action
          className="primary"
          disabled={
            !draft && !inputs.length && !instructions.trim() && !url.trim()
          }
          onError={setError}
          run={async () => {
            const p = await create();
            if (p.current || p.ask?.status === "open") {
              onCreated(p);
              return;
            }
            try {
              const r = await call<{ object: Project }>("objects.start", {
                id: p.id,
              });
              onCreated(r.object);
            } catch (e) {
              setDraft(p);
              throw e;
            }
          }}
        >
          Make it
        </Action>
      </div>
    </Modal>
  );
}

function ConfirmationInbox({
  question,
  project,
  mutate,
}: {
  question?: import("./types").RawQuestion;
  project?: Project;
  mutate: (m: string, p: object) => Promise<unknown>;
}) {
  const raw = question ?? project!.printConfirmation!;
  const [answered, setAnswered] = useState<string>();
  const [error, setError] = useState("");
  const answer = async (value: object) => {
    if (question)
      await call("confirmations.answer", { id: raw.id, answer: value });
    else
      await mutate("objects.answerPrintConfirmation", {
        id: project!.id,
        confirmationId: raw.id,
        answer: value,
      });
    setAnswered(raw.id);
  };
  if (answered === raw.id) return null;
  return (
    <Modal
      key={raw.id}
      title="Your printer needs you"
      onClose={() =>
        void answer({ action: "cancel" }).catch((e) => setError(String(e)))
      }
    >
      <Question key={raw.id} raw={raw} answer={answer} />
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
