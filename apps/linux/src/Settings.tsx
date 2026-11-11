import { addressField, AUTO_UPDATE_LABEL, AUTO_UPDATE_WORDS, autoUpdatePatch, autoUpdateSwitch, mcpUsageWords, mcpMoveNotice, mcpMoves, mcpPackageIds, obtainControl, obtainValue, slicerControls, codeEngineRow, type CodeEngineView } from "./domain";
import { deviceConnected } from "./device-presence";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { mcpUpdateNotice, mcpPhase, type McpPhase } from "./domain";
import { call, host, storeCredential, openLink } from "./bridge";
import type { ObtainStep } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { Action, Modal } from "./ui";
import type {
  CompanionSettings,
  HostStatus,
  McpPackage,
  ModelChoice,
  ModelRecord,
  Printer,
  Route,
  SetupOptions,
} from "./types";
export function Pairing({
  invitation,
  onClose,
}: {
  invitation: { qrPayload: string; expiresAt: number; code: string };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [src, setSrc] = useState("");
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    void QRCode.toDataURL(invitation.qrPayload, {
      width: 420,
      margin: 3,
      errorCorrectionLevel: "M",
    }).then(setSrc);
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, invitation.expiresAt - Date.now()),
    );
    let live = true;
    const check = setInterval(() => {
      void call<{ active: boolean }>("pairing.isActive", {
        code: invitation.code,
      }).then(
        (r) => {
          if (live && !r.active) onClose();
        },
        () => {},
      );
    }, 3000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(check);
    };
  }, [invitation, onClose]);
  return (
    <dialog
      className="qr-only"
      ref={ref}
      aria-label="Connect a phone. Scan this QR code. Press Escape to close."
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {expired ? (
        <p>Pairing code expired. Press Escape and add a phone again.</p>
      ) : src ? (
        <img
          src={src}
          alt="Scan this code with your phone to connect to this computer"
        />
      ) : (
        <p>Creating QR code…</p>
      )}
    </dialog>
  );
}
export function Settings({
  printers,
  onClose,
  onRefresh,
  onPair,
  mcpNotices,
  recordMcpNotice,
}: {
  printers: Printer[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onPair: () => Promise<void>;
  mcpNotices: Record<string, string>;
  recordMcpNotice: (id: string, words: string, begins?: boolean, phase?: McpPhase) => void;
}) {
  const [tab, setTab] = useState("Printers");
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="settings-layout">
        <nav aria-label="Settings sections">
          {["General", "Printers", "Model access", "Devices", "About"].map(
            (t) => (
              <button
                key={t}
                aria-current={t === tab ? "page" : undefined}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ),
          )}
        </nav>
        <section>
          {tab === "General" && <General />}
          {tab === "Printers" && (
            <Printers printers={printers} onRefresh={onRefresh} notices={mcpNotices} setNotice={recordMcpNotice} />
          )}{" "}
          {tab === "Model access" && <Models />}
          {tab === "Devices" && <Devices onPair={onPair} />}{" "}
          {tab === "About" && (
            <>
              <h3>Counterpart for Linux</h3>
              <p>
                Make things that fit your life. Your projects and scans stay on
                this computer.
              </p>
              <p>
                Fusion and CloudKit are unavailable on Linux. Phones connect
                through the local network or Tailscale with the companion’s
                pinned identity.
              </p>
              <Action
                run={() => openLink("https://counterpart.dtmont.com/help.html")}
              >
                Open guide
              </Action>
              <p>
                Scan rig by Kass 3D. Vernier caliper by 3D Print Masters
                Hub. Their original files and licenses stay with their model
                pages.
              </p>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
function General() {
  const [settings, setSettings] = useState<CompanionSettings>();
  const [status, setStatus] = useState<HostStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    void host("status").then(setStatus, (e) => setError(String(e)));
    void call<{ settings: CompanionSettings }>("settings.get").then(
      (r) => setSettings(r.settings),
      (e) => setError(String(e)),
    );
  }, []);
  return (
    <>
      <h3>This computer</h3>
      <p>
        {status?.running
          ? "The companion is running. Jobs continue when you close this window."
          : "The companion is stopped."}
      </p>
      <div className="actions">
        <Action run={async () => setStatus(await host("start"))}>
          Start companion
        </Action>
        <Action run={async () => setStatus(await host("setup"))}>
          Repair setup
        </Action>
        <Action
          run={async () => {
            if (
              !window.confirm(
                "Stop the companion? Active design work will be interrupted and phones will disconnect.",
              )
            )
              return;
            setStatus(await host("stop"));
          }}
        >
          Stop companion…
        </Action>
      </div>
      <label className="field">
        Print milestone notifications
        <select
          disabled={!settings}
          value={settings?.milestones ?? "off"}
          onChange={(e) =>
            void call<{ settings: CompanionSettings }>("settings.set", {
              milestones: e.target.value,
            }).then(
              (r) => setSettings(r.settings),
              (e) => setError(String(e)),
            )
          }
        >
          {[
            ["off", "Off"],
            ["50", "Halfway"],
            ["25-50-75", "25%, 50%, 75%"],
            ["every-10", "Every 10%"],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        The user service starts with your desktop session. Linux has no Dock or
        iCloud notification relay. Sleep prevention and desktop notifications
        depend on host support; no unsupported switches are shown.
      </p>
      {error && <p className="error">{error}</p>}
    </>
  );
}
function Models() {
  const [record, setRecord] = useState<ModelRecord>();
  const [kind, setKind] = useState("none");
  const [provider, setProvider] = useState<"anthropic" | "openai">("openai");
  const [model, setModel] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const load = (r: ModelRecord) => {
    setRecord(r);
    setKind(r.choice.kind);
    if (r.choice.kind === "api") {
      setProvider(r.choice.provider);
      setModel(r.choice.model);
    }
    if (r.choice.kind === "endpoint") {
      setUrl(r.choice.url);
      setModel(r.choice.model);
    }
  };
  useEffect(() => {
    void call<ModelRecord>("modelAccess.get").then(load, (e) =>
      setError(String(e)),
    );
  }, []);
  useEffect(() => {
    if (record?.check?.state !== "checking") return;
    let live = true;
    const timer = setInterval(() => {
      void call<ModelRecord>("modelAccess.get").then(
        (r) => {
          if (live) setRecord(r);
        },
        () => {},
      );
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [record?.check?.state]);
  return (
    <>
      <h3>Your model access</h3>
      <p>
        Choose the account or provider that does design and cleanup. Keys are
        stored by the native host in Secret Service, bound to this exact
        provider, endpoint and model.
      </p>
      <label className="field">
        Use
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setSecret("");
          }}
        >
          <option value="none">Off</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex-cli">Codex CLI</option>
          <option value="api">API provider</option>
          <option value="endpoint">OpenAI-compatible endpoint</option>
        </select>
      </label>
      {kind === "api" && (
        <label className="field">
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as typeof provider);
              setSecret("");
            }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
      )}
      {kind === "endpoint" && (
        <label className="field">
          Endpoint URL
          <input
            type="url"
            value={url}
            placeholder="https://openrouter.ai/api/v1"
            onChange={(e) => {
              setUrl(e.target.value);
              setSecret("");
            }}
          />
          <small>
            OpenRouter or an OpenAI-compatible local service. Plain HTTP is
            intended for local services.
          </small>
        </label>
      )}
      {(kind === "api" || kind === "endpoint") && (
        <>
          <label className="field">
            Model
            <input
              value={model}
              placeholder="Provider’s model identifier"
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className="field">
            API key{kind === "endpoint" ? " (optional for local servers)" : ""}
            <input
              type="password"
              autoComplete="off"
              value={secret}
              placeholder="Stored only in Secret Service"
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
        </>
      )}
      <p className="muted">
        Claude Code and Codex use your existing login on this computer. OpenCode
        CLI is not a selectable worker in the shared protocol yet.
      </p>
      <div className="actions">
        <Action
          disabled={!record}
          className="primary"
          onError={setError}
          run={async () => {
            if (!record) return;
            let choice: ModelChoice;
            if (kind === "api")
              choice = {
                kind: "api",
                provider,
                model: model.trim(),
                keychainRef: crypto.randomUUID(),
              };
            else if (kind === "endpoint")
              choice = {
                kind: "endpoint",
                url: url.trim(),
                model: model.trim(),
              };
            else
              choice = { kind: kind as "none" | "claude-code" | "codex-cli" };
            if (choice.kind === "api" || choice.kind === "endpoint") {
              if (!choice.model)
                throw new Error("Enter the provider’s model identifier.");
              if (secret) {
                const key = secret;
                setSecret("");
                choice = (await storeCredential(choice, key)).choice;
              } else {
                const old = record.choice;
                const same =
                  choice.kind === old.kind &&
                  "model" in old &&
                  old.model === choice.model &&
                  (choice.kind === "api" && old.kind === "api"
                    ? choice.provider === old.provider
                    : choice.kind === "endpoint" &&
                      old.kind === "endpoint" &&
                      choice.url === old.url);
                if (same && "keychainRef" in old && old.keychainRef)
                  choice = { ...choice, keychainRef: old.keychainRef };
                else if (choice.kind === "api")
                  throw new Error(
                    "Enter a new API key for this exact provider and model.",
                  );
              }
            }
            const saved = await call<ModelRecord>("modelAccess.set", {
              expectedRevision: record.revision,
              choice,
            });
            load(saved);
          }}
        >
          Save choice
        </Action>
        <Action
          disabled={!record}
          onError={setError}
          run={async () => {
            if (record)
              setRecord(
                await call<ModelRecord>("modelAccess.check", {
                  revision: record.revision,
                }),
              );
          }}
        >
          Test connection
        </Action>
        <Action
          run={async () => load(await call<ModelRecord>("modelAccess.get"))}
        >
          Refresh
        </Action>
      </div>
      <p role="status">
        {record?.check
          ? `${record.check.state}${record.check.outcome ? ` · ${record.check.outcome}` : ""}`
          : "Connection not tested"}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <hr />
      <h3>Design engine</h3>
      <CodeEngine />
      <p>
        Without the code design engine, Blender is launched by your printer MCP
        when a pass needs it. Autodesk Fusion is unavailable on Linux.
      </p>
      <Blender />
    </>
  );
}
/** The printer MCP's code design engine (PRD §8.9): its cad_status, and Set Up (cad_setup), run by the companion. */
function CodeEngine() {
  const [view, setView] = useState<CodeEngineView>();
  const [error, setError] = useState("");
  const read = async () =>
    setView((await call<{ cad: CodeEngineView }>("cad.status")).cad);
  useEffect(() => {
    void read().catch((e) => setError(String(e)));
  }, []);
  const row = codeEngineRow(view);
  useEffect(() => {
    if (!row.working || !view) return;
    const timer = setInterval(
      () => void read().catch((e) => setError(String(e))),
      2000,
    );
    return () => clearInterval(timer);
  }, [row.working, view?.state]);
  return (
    <>
      <h4>Code design engine</h4>
      <p role="status">{row.message}</p>
      {row.size && <p>{row.size}</p>}
      {row.action && (
        <Action
          run={async () =>
            setView((await call<{ cad: CodeEngineView }>("cad.setup")).cad)
          }
        >
          {row.action}
        </Action>
      )}
      {row.result && (
        <p className={row.result.ok ? undefined : "notice"}>
          {row.result.message}
        </p>
      )}
      {row.result?.suggestion && <p>{row.result.suggestion}</p>}
      <p>
        Designs new parts and cleans up scans as a script, without opening
        Blender, and a later change starts from that script. It runs inside{" "}
        {view?.server ?? "your printer MCP"} on this computer; Set Up downloads
        it there. Printing an existing model never needs it.
      </p>
      {error && <p className="notice">{error}</p>}
    </>
  );
}
function Blender() {
  const [status, setStatus] = useState<{
    state: string;
    message: string;
    canUpdate: boolean;
  }>();
  const [error, setError] = useState("");
  const read = async () =>
    setStatus(
      (await call<{ blender: NonNullable<typeof status> }>("blender.status"))
        .blender,
    );
  useEffect(() => {
    void read().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (!["checking", "updating"].includes(status?.state ?? "")) return;
    const timer = setInterval(
      () => void read().catch((e) => setError(String(e))),
      1500,
    );
    return () => clearInterval(timer);
  }, [status?.state]);
  return (
    <>
      <Action
        run={async () =>
          setStatus(
            (
              await call<{ blender: NonNullable<typeof status> }>(
                "blender.check",
              )
            ).blender,
          )
        }
      >
        Check Blender setup
      </Action>
      <Action
        disabled={!status?.canUpdate}
        run={async () =>
          setStatus(
            (
              await call<{ blender: NonNullable<typeof status> }>(
                "blender.update",
              )
            ).blender,
          )
        }
      >
        Repair Blender add-on
      </Action>
      {status && <p>{status.message}</p>}
      {error && <p className="notice">{error}</p>}
    </>
  );
}
interface Device {
  deviceId: string;
  deviceName: string;
  model?: string;
  pairedAt: number;
  lastSeenAt?: number;
  lastRefreshedAt: number;
  legacy?: boolean;
}
function Devices({ onPair }: { onPair: () => Promise<void> }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [nearby, setNearby] = useState<
    { id: string; deviceName: string; code: string; expiresAt: number }[]
  >([]);
  const [error, setError] = useState("");
  const refresh = async () => {
    const [a, b] = await Promise.all([
      call<{ devices: Device[] }>("devices.list"),
      call<{ items: typeof nearby }>("nearby.list"),
    ]);
    setDevices(a.devices);
    setNearby(b.items);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <h3>Phones & tablets</h3>
      <Action className="primary" run={onPair}>
        Add a phone…
      </Action>
      {nearby
        .filter((r) => r.expiresAt > Date.now())
        .map((r) => (
          <section className="question" key={r.id}>
            <h3>{r.deviceName}</h3>
            <p>
              Check that the phone shows{" "}
              <strong className="pair-code">{r.code}</strong>.
            </p>
            <Action
              run={async () => {
                await call("nearby.answer", { id: r.id, allow: false });
                await refresh();
              }}
            >
              Deny
            </Action>
            <Action
              className="primary"
              run={async () => {
                await call("nearby.answer", { id: r.id, allow: true });
                await refresh();
              }}
            >
              Allow this phone
            </Action>
          </section>
        ))}
      {devices.map((d) => (
        <div className="settings-row" key={d.deviceId}>
          <div>
            <strong>{d.deviceName}</strong>
            <small>
              {d.model} ·{" "}
              {d.legacy
                ? "Older pairing"
                : deviceConnected(d)
                  ? "Connected"
                  : d.lastSeenAt === undefined
                    ? "Not seen yet"
                    : `Last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
            </small>
            <small>Paired {new Date(d.pairedAt).toLocaleDateString()}</small>
          </div>
          <Action
            run={async () => {
              if (
                window.confirm(
                  `Remove ${d.deviceName}? It will need to connect again.`,
                )
              ) {
                await call("devices.remove", { deviceId: d.deviceId });
                await refresh();
              }
            }}
          >
            Remove…
          </Action>
        </div>
      ))}
      {!devices.length && <p>No paired devices yet.</p>}
      {error && <p className="error">{error}</p>}
      <p className="muted">
        QR and nearby pairing use the companion’s pinned identity and available
        LAN/Tailscale addresses. iCloud enrollment is unavailable on Linux.
      </p>
    </>
  );
}
function Printers({
  printers,
  onRefresh,
  notices,
  setNotice,
}: {
  printers: Printer[];
  onRefresh: () => Promise<void>;
  notices: Record<string, string>;
  setNotice: (id: string, words: string, begins?: boolean, phase?: McpPhase) => void;
}) {
  const [packages, setPackages] = useState<McpPackage[]>([]);
  const [options, setOptions] = useState<SetupOptions>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<CompanionSettings>();
  const autoUpdate = autoUpdateSwitch(settings);
  useEffect(() => {
    void call<{ settings: CompanionSettings }>("settings.get").then((r) => setSettings(r.settings), () => {});
  }, []);
  const refresh = async () => {
    const r = await call<{ packages: McpPackage[]; options: SetupOptions }>(
      "printers.mcps",
    );
    setPackages(r.packages);
    setOptions(r.options);
    await onRefresh();
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch(() => {}), 12000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="section-head">
        <h3>Your printers</h3>
        <button onClick={() => setAdding(true)}>Add printer…</button>
      </div>
      {printers.map((p) => (
        <PrinterRow
          key={p.id}
          printer={p}
          options={options}
          refresh={refresh}
        />
      ))}
      {!printers.length && (
        <p>
          Add your printer when you’re ready. Pairing and projects work without
          one.
        </p>
      )}
      <h3>Printer tools</h3>
      <p>
        Download and update the published MCP packages. They handle slicing,
        camera and printer controls.
      </p>
      {autoUpdate.shown && (
        <>
          <label className="choice">
            <input
              type="checkbox"
              checked={autoUpdate.on}
              onChange={(e) =>
                void call<{ settings: CompanionSettings }>("settings.set", autoUpdatePatch(e.target.checked)).then(
                  (r) => setSettings(r.settings),
                  (e) => setError(String(e)),
                )
              }
            />
            <span>{AUTO_UPDATE_LABEL}</span>
          </label>
          <p className="muted">{AUTO_UPDATE_WORDS}</p>
        </>
      )}
      {packages.map((pkg) => (
        // One group per MCP: a screen reader names it, and its Move and Update buttons and progress belong to it.
        <section className="package" key={pkg.package} role="group" aria-labelledby={`mcp-${pkg.package}`}>
          <strong id={`mcp-${pkg.package}`}>{pkg.label}</strong>
          <p>{pkg.description}</p>
          <small>
            {pkg.installed
              ? `Installed ${pkg.version ?? "version unknown"}`
              : "Not installed"}
            {pkg.latestVersion ? ` · Latest ${pkg.latestVersion}` : ""}
          </small>
          {pkg.appCopy && (
            <p>Counterpart’s copy {pkg.appCopy.version ?? "version unknown"}</p>
          )}
          {(pkg.uses ?? []).map((use) => (
            <p key={use.destinationId}>{mcpUsageWords(use)}</p>
          ))}
          {mcpMoves(pkg).map(({ mcpId, title }) => (
            <div key={mcpId}>
              <Action
                run={async () => {
                  setNotice(mcpId, "Requesting move…", true);
                  const result = await call<{ update: {state: string; found?: string} }>(
                    "printers.updateMcp",
                    { mcpId, fresh: true },
                  );
                  setNotice(mcpId, mcpMoveNotice(result), false, mcpPhase(result));
                  await refresh();
                }}
              >
                {title}
              </Action>
              <small>
                Updates Counterpart’s copy and switches these profiles. Your
                copy is left untouched.
              </small>
            </div>
          ))}
          <div className="actions">
            <Action
              run={async () => {
                setNotice(pkg.appMcpId, "Checking download…", true);
                const r = await call<{
                  update?: { state: string; found?: string };
                }>("printers.installMcp", { package: pkg.package });
                setNotice(
                    pkg.appMcpId,
                  r.update?.found ?? r.update?.state ?? "Already installed.",
                );
                await refresh();
              }}
            >
              {pkg.installed ? "Check download" : "Download"}
            </Action>
            {pkg.installed && (
              <Action
                label={`Update Counterpart’s copy of ${pkg.label}`}
                run={async () => {
                  setNotice(pkg.appMcpId, "Requesting update…", true);
                  const r = await call<{
                    update?: { state: string; toVersion?: string; found?: string };
                    state?: string;
                    toVersion?: string;
                    found?: string;
                  }>("printers.updateMcp", { mcpId: pkg.appMcpId });
                  setNotice(pkg.appMcpId, mcpUpdateNotice(r), false, mcpPhase(r));
                  await refresh();
                }}
              >
                Update app copy
              </Action>
            )}
          </div>
          {/* Whichever client started it (the Mac, a phone, this one): the events say where it is. */}
          {mcpPackageIds(pkg).filter((id) => notices[id]).map((id) => (
            <p role="status" className="notice" key={id}>{notices[id]}</p>
          ))}
        </section>
      ))}
      {Object.entries(notices).filter(([id]) => !packages.some((pkg) => mcpPackageIds(pkg).includes(id))).map(([id, notice]) => (
        <p role="status" className="notice" key={id}>{notice}</p>
      ))}
      {error && <p className="error">{error}</p>}
      {adding && (
        <AddPrinter
          options={options}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            await refresh();
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
function PrinterRow({
  printer: p,
  options,
  refresh,
}: {
  printer: Printer;
  options?: SetupOptions;
  refresh: () => Promise<void>;
}) {
  const [route, setRoute] = useState<Route | null>();
  const [model, setModel] = useState(p.model ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void call<{ route: Route | null }>("printers.route", {
      destinationId: p.id,
    }).then(
      (r) => {
        if (live) setRoute(r.route);
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [p.id]);
  return (
    <section className="printer-row">
      <h3>
        {p.name} <span className="status-dot" />
        {p.state ?? "Checking"}
      </h3>
      <p>
        {p.model?.toUpperCase()} · {p.address} · {p.backend}
      </p>
      {p.mcps && p.mcps.length > 1 && (
        <label className="field">
          Printer MCP
          <select
            value={p.backend}
            onChange={(e) =>
              void call("printers.chooseMcp", {
                destinationId: p.id,
                backend: e.target.value,
              }).then(refresh, (e) => setError(String(e)))
            }
          >
            {p.mcps.map((m) => (
              <option key={m.backend}>{m.backend}</option>
            ))}
          </select>
        </label>
      )}
      {route && (
        <label className="field">
          Connection
          <select
            value={route.route}
            onChange={(e) =>
              void call<{ route: Route }>("printers.route", {
                destinationId: p.id,
                route: e.target.value,
              }).then(
                (r) => setRoute(r.route),
                (e) => setError(String(e)),
              )
            }
          >
            {(
              route.options ??
              route.choices.map((id) => ({
                id,
                label: id,
                available: true,
                reason: undefined,
              }))
            ).map((r) => (
              <option key={r.id} value={r.id} disabled={r.available === false}>
                {r.label ?? r.id}
                {r.reason ? ` · ${r.reason}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {route === null && (
        <small>This MCP does not offer a connection choice.</small>
      )}
      {p.incomplete && (
        <div className="notice">
          <p>Missing settings: {p.incomplete.missing.join(", ")}</p>
          <select
            aria-label="Printer model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Choose model</option>
            {options?.models[p.backend]?.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Action
            run={async () => {
              await call("printers.completeSettings", {
                destinationId: p.id,
                ...(model ? { model } : {}),
              });
              await refresh();
            }}
          >
            Complete settings
          </Action>
        </div>
      )}
      <div className="actions">
        {p.mcpId && (
          <Action
            run={async () => {
              const r = await call<{
                update: { state: string; found?: string };
              }>("printers.updateMcp", { mcpId: p.mcpId });
              setMessage(r.update.found ?? r.update.state);
              await refresh();
            }}
          >
            Update this printer’s MCP
          </Action>
        )}
        {message && /unresolved|checkout|fresh/i.test(message) && (
          <Action
            run={async () => {
              await call("printers.updateMcp", { mcpId: p.mcpId, fresh: true });
              await refresh();
            }}
          >
            Install a fresh published copy
          </Action>
        )}
        <Action
          run={async () => {
            if (window.confirm(`Remove ${p.name} from Counterpart?`)) {
              await call("printers.remove", { destinationId: p.id });
              await refresh();
            }
          }}
        >
          Remove…
        </Action>
      </div>
      {message && <p className="notice">{message}</p>}
      {error && <p className="notice">{error}</p>}
    </section>
  );
}
interface Candidate {
  id: string;
  name: string;
  host?: string;
  port?: string;
  serial?: string;
  model?: string;
  backend: string;
  printerType: string;
  folder?: string;
  added: boolean;
  missing?: string[];
}
function AddPrinter({
  options: initial,
  onClose,
  onAdded,
}: {
  options?: SetupOptions;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const [options, setOptions] = useState(initial);
  const [found, setFound] = useState<Candidate[]>([]);
  const [form, setForm] = useState<Record<string, string>>({
    backend: "bambu-printer-mcp",
    printerType: "bambu",
    host: "",
  });
  const [error, setError] = useState("");
  const [check, setCheck] = useState<{
    reached: boolean;
    camera: string;
    image?: { mimeType: string; base64: string };
  }>();
  const type = options?.types.find((t) => t.printerType === form.printerType);
  const slicer = slicerControls(options, form.backend);
  // The key fetched through the MCP (approved in the printer's own page), when its field says it can.
  const obtain = obtainControl(options, form);
  const [obtaining, setObtaining] = useState<ObtainStep>();
  // Bumped when the sheet closes or the printer changes: an approval still waiting stops asking and isn't shown.
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { generation.current++; setObtaining(undefined); }, [form.backend, form.printerType, form.host, form.port]);
  const update = (key: string, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  // The MCP that drives this kind here, from the MCPs' own fields: never one that isn't installed.
  useEffect(() => {
    if (type && !type.backends.includes(form.backend) && type.backends[0])
      setForm((f) => ({ ...f, backend: type.backends[0]!, slicer: "" }));
  }, [type, form.backend]);
  const payload = () =>
    Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
  return (
    <Modal title="Add a printer" onClose={onClose}>
      <Action
        run={async () => {
          const r = await call<{
            found: Candidate[];
            options: SetupOptions;
            network: string;
          }>("printers.discover");
          setFound(r.found);
          setOptions(r.options);
          if (r.network === "unavailable")
            setError(
              "Network discovery is unavailable. You can enter the printer address below.",
            );
        }}
      >
        Find printers
      </Action>
      {found.map((p) => (
        <div className="settings-row" key={p.id}>
          <strong>{p.name}</strong>
          {p.folder ? (
            <Action
              disabled={p.added}
              run={async () => {
                await invoke("add_discovered_printer", { id: p.id });
                await onAdded();
              }}
            >
              {p.added ? "Added" : "Add configured printer"}
            </Action>
          ) : (
            <button
              disabled={p.added}
              onClick={() =>
                setForm({
                  backend: p.backend,
                  printerType: p.printerType,
                  host: p.host ?? "",
                  port: p.port ?? "",
                  serial: p.serial ?? "",
                  model: p.model ?? "",
                })
              }
            >
              Use
            </button>
          )}
        </div>
      ))}
      <label className="field">
        Type
        <select
          value={form.printerType}
          onChange={(e) => {
            const t = options?.types.find(
              (x) => x.printerType === e.target.value,
            );
            setForm({
              host: form.host,
              printerType: e.target.value,
              backend: t?.backends[0] ?? "mcp-3d-printer-server",
            });
          }}
        >
          {options?.types.map((t) => (
            <option key={t.printerType} value={t.printerType}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Printer MCP
        <select
          value={form.backend}
          // A slicer choice belongs to the MCP that offered it.
          onChange={(e) => setForm((f) => ({ ...f, backend: e.target.value, slicer: "" }))}
        >
          {type?.backends.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      {["name", "host", "port", ...(type?.serial ? ["serial"] : [])].map(
        (key) => (
          <label className="field" key={key}>
            {
              (
                {
                  name: "Name (optional)",
                  host: "Address",
                  port: "Port (optional)",
                  serial: "Serial number",
                } as Record<string, string>
              )[key]
            }
            <input
              value={form[key] ?? ""}
              placeholder={key === "host" ? addressField(options, form.printerType).placeholder : undefined}
              onChange={(e) => {
                update(key, e.target.value);
                if (key === "serial") {
                  // The MCP's own serial table; its prefixes are all one length.
                  const length = Object.keys(options?.serialModels ?? {})[0]
                    ?.length;
                  const detected = length
                    ? options?.serialModels?.[
                        e.target.value.trim().slice(0, length).toUpperCase()
                      ]
                    : undefined;
                  if (detected) update("model", detected);
                }
              }}
            />
            {key === "host" && addressField(options, form.printerType).hint && (
              <small>{addressField(options, form.printerType).hint}</small>
            )}
          </label>
        ),
      )}
      {type?.serial && (
        <label className="field">
          Model
          <select
            value={form.model ?? ""}
            onChange={(e) => update("model", e.target.value)}
          >
            <option value="">Choose model</option>
            {options?.models[form.backend]?.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type?.secret && (
        <label className="field">
          {type.secret.label}
          {type.secret.required ? " *" : ""}
          <input
            type="password"
            autoComplete="off"
            value={form.secret ?? ""}
            onChange={(e) => update("secret", e.target.value)}
          />
          {type.secret.hint && <small>{type.secret.hint}</small>}
        </label>
      )}
      {obtain && (
        <div className="field">
          <Action
            disabled={!form.host || obtaining?.status === "pending"}
            onError={(message) => setObtaining({ status: "failed", message })}
            run={async () => {
              const asked = { ...form };
              const mine = generation.current;
              const stopped = () => generation.current !== mine;
              const last = await obtainValue(call, asked, (step) => { if (!stopped()) setObtaining(step); }, stopped);
              if (last.status === "approved" && last.value && !stopped()) setForm((f) => ({ ...f, secret: last.value! }));
            }}
          >
            {obtain.label}
          </Action>
          {obtain.hint && !obtaining && <small>{obtain.hint}</small>}
          {obtaining && (
            <p className={obtaining.status === "failed" ? "error" : "notice"}>
              {obtaining.status === "approved" ? `✓ ${obtaining.message}` : obtaining.message}
              {obtaining.status === "pending" && obtaining.approveUrl && (
                <>
                  {" "}
                  <button className="link" onClick={() => void openLink(obtaining.approveUrl!)}>
                    Open the approval page
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      )}
      {/* The slicer the MCP runs, from its own list: chosen with its app below, so the two always agree. */}
      {slicer?.choice && (
        <label className="field">
          {slicer.choice.label}
          <select value={slicer.selected(form)} onChange={(e) => update("slicer", slicer.choose(e.target.value))}>
            {slicer.choice.choices!.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Where the slicer and its Bambu profiles are, when the MCP can't find them (the MCP's own fields). */}
      {(slicer?.paths ?? []).map(({ field: f, key, placeholder }) => (
        <label className="field" key={f.name}>
          {f.label}
          {f.required ? " *" : ""}
          <input value={form[key] ?? ""} placeholder={placeholder} onChange={(e) => update(key, e.target.value)} />
          {f.hint && <small>{f.hint}</small>}
        </label>
      ))}
      {(options?.updates ?? []).map((u) => (
        <p className="notice" key={u.package}>
          {u.message}
        </p>
      ))}
      {check && (
        <div className="notice">
          {check.reached ? "Printer connected" : "Printer not reached"} ·
          Camera: {check.camera}
          {check.image && (
            <img
              className="check-camera"
              src={`data:${check.image.mimeType};base64,${check.image.base64}`}
              alt="Camera test"
            />
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <Action
          disabled={!form.host}
          onError={setError}
          run={async () =>
            setCheck(
              (
                await call<{ check: NonNullable<typeof check> }>(
                  "printers.check",
                  { printer: payload() },
                )
              ).check,
            )
          }
        >
          Check connection
        </Action>
        <Action
          disabled={!form.host}
          className="primary"
          onError={setError}
          run={async () => {
            await call("printers.add", { printer: payload() });
            setForm((f) => ({ ...f, secret: "" }));
            await onAdded();
          }}
        >
          Add printer
        </Action>
      </div>
    </Modal>
  );
}
