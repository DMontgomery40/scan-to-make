import { useEffect, useRef, useState } from "react";
import { artifact } from "./bridge";
import type { Project } from "./types";
import { canLocate, filePath, gallery, drawnColour, photoPicture, still, sizeText, stageStill, pictureClock, type GalleryKind, type Still } from "./gallery";
export function Picture({
  id,
  path,
  alt,
  className = "",
  onFailed,
  loadingText = "Loading preview…",
}: {
  id: string;
  path?: string;
  alt: string;
  className?: string;
  /** Called when the picture can't be fetched or decoded, so a caller can hide what it framed (review F2 on #456). */
  onFailed?: () => void;
  /** What the placeholder says while the picture comes. */
  loadingText?: string;
}) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true,
      url: string | undefined;
    setSrc(undefined);
    setFailed(false);
    if (path)
      void artifact(id, path).then(
        (bytes) => {
          if (!live) return;
          const ext = path.split(".").pop()?.toLowerCase();
          url = URL.createObjectURL(
            new Blob([bytes as BlobPart], {
              type:
                ext === "png"
                  ? "image/png"
                  : ext === "webp"
                    ? "image/webp"
                    : "image/jpeg",
            }),
          );
          setSrc(url);
        },
        () => {
          if (live) {
            setFailed(true);
            onFailed?.();
          }
        },
      );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, path]);
  return src ? (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => {
        setFailed(true);
        setSrc(undefined);
        onFailed?.();
      }}
    />
  ) : (
    <div className={`picture-placeholder ${className}`} aria-label={alt}>
      {failed ? "Preview unavailable" : path ? loadingText : "◇"}
    </div>
  );
}
/** The neutral material every layout uses for a part with no spool. */
export const NEUTRAL_MATERIAL = 0x94949a;
/**
 * `tint` is the spool the part prints in (`#RRGGBB`); without one, the neutral material every layout uses. `parts` (#691)
 * draws several meshes in one frame instead, each in its own tint, centred together so they keep their places.
 */
export function ModelStage({ bytes, tint, parts }: { bytes?: Uint8Array; tint?: string; parts?: { bytes: Uint8Array; tint?: string }[] }) {
  const element = useRef<HTMLDivElement>(null);
  const action = useRef<(a: string) => void>(() => {});
  const [error, setError] = useState("");
  const [facts, setFacts] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setError("");
    void Promise.all([
      import("three"),
      import("three/addons/loaders/STLLoader.js"),
      import("three/addons/controls/OrbitControls.js"),
    ])
      .then(([T, { STLLoader }, { OrbitControls }]) => {
        if (disposed || !element.current) return;
        let renderer: InstanceType<typeof T.WebGLRenderer> | undefined;
        const pieces = parts ?? (bytes ? [{ bytes, tint }] : []);
        const geometries: ReturnType<InstanceType<typeof STLLoader>["parse"]>[] = [];
        const materials: InstanceType<typeof T.MeshStandardMaterial>[] = [];
        try {
          const box = new T.Box3();
          for (const piece of pieces) {
            const geometry = new STLLoader().parse(
              piece.bytes.buffer.slice(piece.bytes.byteOffset, piece.bytes.byteOffset + piece.bytes.byteLength) as ArrayBuffer,
            );
            geometries.push(geometry);
            if (!geometry.getAttribute("position")?.count)
              throw new Error("This STL has no viewable geometry.");
            geometry.computeBoundingBox();
            box.union(geometry.boundingBox!);
          }
          if (!geometries.length) throw new Error("This STL has no viewable geometry.");
          const centre = box.getCenter(new T.Vector3());
          for (const geometry of geometries) {
            geometry.translate(-centre.x, -centre.y, -centre.z);
            geometry.computeVertexNormals();
          }
          const span = box.getSize(new T.Vector3());
          const radius = Math.max(span.x, span.y, span.z);
          if (!Number.isFinite(radius) || radius <= 0)
            throw new Error("This STL has invalid dimensions.");
          renderer = new T.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: "low-power",
          });
          renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
          renderer.setClearColor(0, 0);
          renderer.outputColorSpace = T.SRGBColorSpace;
          const canvas = renderer.domElement;
          canvas.setAttribute(
            "aria-label",
            "3D model. Drag to orbit, scroll to zoom, or use the buttons below.",
          );
          canvas.setAttribute("role", "img");
          element.current.replaceChildren(canvas);
          const scene = new T.Scene();
          const model = new T.Group();
          geometries.forEach((geometry, i) => {
            const colour = pieces[i]!.tint;
            const material = new T.MeshStandardMaterial({
              color: colour ? parseInt(colour.slice(1), 16) : NEUTRAL_MATERIAL,
              metalness: 0.08,
              roughness: 0.6,
              side: T.DoubleSide,
            });
            materials.push(material);
            model.add(new T.Mesh(geometry, material));
          });
          model.rotation.x = -Math.PI / 2;
          scene.add(model);
          scene.add(new T.HemisphereLight(0xffffff, 0x4e5b57, 1.4));
          const light = new T.DirectionalLight(0xffffff, 2);
          light.position.set(4, 6, 5);
          scene.add(light);
          const fill = new T.DirectionalLight(0xc6d6ff, 1);
          fill.position.set(-4, 0, -3);
          scene.add(fill);
          const camera = new T.PerspectiveCamera(
            36,
            1,
            radius / 1000,
            radius * 100,
          );
          const home = () =>
            camera.position.set(radius * 1.25, radius * 0.85, radius * 1.7);
          home();
          const controls = new OrbitControls(camera, canvas);
          controls.enableDamping = false;
          controls.minDistance = radius * 0.15;
          controls.maxDistance = radius * 8;
          let frame = 0;
          const render = () => {
            if (frame || disposed || document.hidden) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              renderer?.render(scene, camera);
            });
          };
          controls.addEventListener("change", render);
          const resize = () => {
            if (!element.current) return;
            const { width, height } = element.current.getBoundingClientRect();
            renderer!.setSize(width, height);
            camera.aspect = width / Math.max(height, 1);
            camera.updateProjectionMatrix();
            render();
          };
          const observer = new ResizeObserver(resize);
          observer.observe(element.current);
          document.addEventListener("visibilitychange", render);
          action.current = (a) => {
            if (a === "reset") {
              home();
              controls.target.set(0, 0, 0);
            } else if (a === "left" || a === "right") {
              camera.position.applyAxisAngle(
                new T.Vector3(0, 1, 0),
                a === "left" ? 0.25 : -0.25,
              );
            } else camera.position.multiplyScalar(a === "in" ? 0.8 : 1.25);
            controls.update();
            render();
          };
          controls.update();
          resize();
          const gl = renderer.getContext();
          const info = gl.getExtension("WEBGL_debug_renderer_info");
          setFacts(
            `${(geometries.reduce((n, g) => n + g.getAttribute("position").count, 0) / 3) | 0} triangles${geometries.length > 1 ? ` in ${geometries.length} parts` : ""} · WebGL 2 · ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`,
          );
          cleanup = () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener("visibilitychange", render);
            controls.dispose();
            geometries.forEach((g) => g.dispose());
            materials.forEach((m) => m.dispose());
            renderer?.dispose();
            renderer?.forceContextLoss();
            canvas.remove();
            action.current = () => {};
          };
        } catch (e) {
          geometries.forEach((g) => g.dispose());
          materials.forEach((m) => m.dispose());
          renderer?.dispose();
          setError(
            e instanceof Error
              ? e.message
              : "3D preview unavailable on this graphics driver.",
          );
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [bytes, tint, parts]);
  return (
    <div className="model-view">
      <div className="canvas" ref={element} />
      {error && (
        <p role="alert" className="stage-error">
          {error} Use the still preview or open in a modeling app.
        </p>
      )}
      <div className="orbit-tools" aria-label="3D view controls">
        <button onClick={() => action.current("left")} aria-label="Orbit left">
          ↶
        </button>
        <button
          onClick={() => action.current("right")}
          aria-label="Orbit right"
        >
          ↷
        </button>
        <button onClick={() => action.current("in")} aria-label="Zoom in">
          +
        </button>
        <button onClick={() => action.current("out")} aria-label="Zoom out">
          −
        </button>
        <button onClick={() => action.current("reset")}>Reset view</button>
      </div>
      <details className="graphics">
        <summary>Rendering details</summary>
        {facts}
        <p>
          WebKit may mask the GPU identity. System graphics diagnostics are
          authoritative.
        </p>
      </details>
    </div>
  );
}
/**
 * The one still picture on a project's stage (review B1/S7 on #539, CounterpartKit `Project.still(for:)`): every still
 * goes through it, and it is never a bare mark. Shown: the picture. Waiting: what is coming, in one line, and only while
 * something is running or for a short while (#626, `stageStill`). Not available: a symbol and one line saying so, with
 * Try again where it can help. Never a picture of something else.
 */
export function StagePicture({ project, still: shown, label, unavailableLine, role, also }: {
  project: Project; still: Still; label: string; unavailableLine: string;
  /** The gallery entry's kind, so a picture the computer never drew settles into its reason (#626). */
  role?: GalleryKind;
  /** A second sentence for the settled reason: where else to see it ("Explore in 3D shows the model itself."). */
  also?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const path = typeof shown === "object" ? shown.picture : undefined;
  const waitingKey = `${project.id}#${role ?? ""}#${label}#${shown === "waiting" ? "waiting" : path ?? "none"}#${attempt}`;
  // Every new thing to wait for starts its own clock; Try again starts it again (`pictureClock`).
  const [, setTick] = useState(0);
  const clock = useRef<ReturnType<typeof pictureClock>>(undefined);
  clock.current ??= pictureClock(() => setTick((n) => n + 1));
  useEffect(() => clock.current!.watch(waitingKey, shown === "waiting"), [waitingKey]);
  useEffect(() => () => clock.current?.stop(), []);
  const settled = stageStill(project, shown, label, unavailableLine, clock.current.waited(waitingKey), role);
  const coming = `${label}: coming from your computer`;
  if (path && !failed)
    return (
      <Picture key={`${path}#${attempt}`} id={project.id} path={path} alt={`${label}, as your computer drew it`} className="hero-picture"
        loadingText={coming} onFailed={() => setFailed(true)} />
    );
  const settledLine = settled.state === "picture" ? "" : settled.state === "not available" && settled.retry && also ? `${settled.line} ${also}` : settled.line;
  const line = path ? "The picture didn't come from your computer." : settledLine;
  const retry = !!path || (settled.state === "not available" && settled.retry);
  const state = !path && settled.state === "waiting" ? "loading" : "not available";
  return (
    <div className="picture-placeholder hero-picture stage-still" role="img" aria-label={`${label}. ${line}`} data-state={state}>
      <span aria-hidden="true">{state === "loading" ? "…" : "◇"}</span>
      <p>{line}</p>
      {retry && (
        <button onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>Try again</button>
      )}
    </div>
  );
}

/**
 * The project's pictures (PRD §5.4): each entry of its gallery (what will print in its spool, the two together, what
 * was scanned, a designer's plates), one at a time, chosen by a row of labels under the stage; none for one entry.
 * The part turns in 3D in its spool; the others show the pictures the computer drew of them.
 */
export function Stage({ project, locate }: { project: Project; locate?: () => void }) {
  const entries = gallery(project);
  const [chosen, setChosen] = useState<string>();
  const entry = entries.find((e) => e.id === chosen) ?? entries[0];
  const [mode, setMode] = useState<"still" | "3d">("still");
  const [bytes, setBytes] = useState<Uint8Array>();
  const [partBytes, setPartBytes] = useState<{ bytes: Uint8Array; tint?: string }[]>();
  const [error, setError] = useState("");
  const [renderIndex, setRenderIndex] = useState(0);
  const model = project.current?.model;
  const renders = project.current?.renders ?? [];
  // #691: a multi-part design turns part by part, each in its own colour (floored on the dark stage).
  // A kit's plate drawn by its parts turns too.
  const parts = (entry?.kind === "part" || entry?.kind === "plate") && "parts" in entry.drawing ? entry.drawing.parts : undefined;
  const turnable = !!parts || (entry?.kind === "part" && "model" in entry.drawing && !!model);
  const canTurn = turnable && (!!parts || filePath(project, "model.stl").toLowerCase().endsWith(".stl"));
  // The pass's own views stay one click away on the part while the computer hasn't drawn its picture.
  const showRenders = entry?.kind === "part" && !project.pictures?.part && renders.length > 1;
  // With nothing in the gallery yet (photos sent, no model): the subject the computer cut out, as on its card; a
  // published model's own page picture before its file is here. Otherwise the stage says it is coming or that it can't.
  const first = photoPicture(project) ?? project.credit?.thumbnail;
  const shown: Still = showRenders
    ? { picture: renders[renderIndex] ?? renders[0]! }
    : entry
      ? (() => { const s = still(project, entry); return typeof s === "object" ? { picture: filePath(project, s.picture) } : s; })()
      : first ? { picture: first } : project.state === "new" || project.state === "touching-up" ? "waiting" : "not available";
  useEffect(() => {
    setMode("still");
    setBytes(undefined);
    setPartBytes(undefined);
    setError("");
    setRenderIndex(0);
  }, [project.id, model, project.passes.at(-1)?.endedAtMs, entry?.id]);
  useEffect(() => {
    if (mode !== "3d" || !parts) return;
    let live = true;
    void Promise.all(parts.map((part) => artifact(project.id, part.mesh))).then(
      (all) => {
        if (live) setPartBytes(all.map((data, i) => ({ bytes: data, ...(parts[i]!.colour.startsWith("#") ? { tint: drawnColour(parts[i]!.colour) } : {}) })));
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
      setPartBytes(undefined);
    };
    // #691: parts remade after the project was ready keep their names; the event that says so (designRevision) redraws them.
  }, [mode, parts?.map((part) => part.mesh).join("|"), project.id, model, project.designRevision]);
  useEffect(() => {
    if (mode !== "3d" || !turnable || parts) return;
    let live = true;
    void artifact(project.id, filePath(project, "model.stl")).then(
      (data) => {
        if (live) setBytes(data);
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
      setBytes(undefined);
    };
  }, [mode, turnable, project.id, model]);
  // The stage's material colour: floored so a dark spool reads on the dark stage; swatches keep the real colour.
  const tint = entry && entry.colour.startsWith("#") ? drawnColour(entry.colour) : undefined;
  return (
    <section className="stage" aria-label="Project pictures">
      {mode === "3d" && turnable ? (
        parts && partBytes ? (
          <ModelStage parts={partBytes} />
        ) : !parts && bytes ? (
          <ModelStage bytes={bytes} tint={tint} />
        ) : (
          <p>{error || "Opening model…"}</p>
        )
      ) : (
        <StagePicture project={project} still={shown} label={entry?.label ?? (first ? "Your photo" : project.title ?? "Your project")}
          role={entry?.kind} also={canTurn ? (parts && parts.length > 1 ? `Explore in 3D shows its ${parts.length} parts, each in its own colour.` : "Explore in 3D shows the model itself.") : undefined}
          unavailableLine={!entry ? "Nothing to show yet." : entry.kind === "plate" ? "No picture of this plate came with the file." : "Your computer couldn't draw a picture of this."} />
      )}
      {entries.length > 1 && (
        <div className="gallery-labels" role="tablist" aria-label="Pictures">
          {entries.map((e) => (
            <button key={e.id} role="tab" aria-selected={e.id === entry?.id} onClick={() => setChosen(e.id)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
      <div className="stage-switch">
        <button aria-pressed={mode === "still"} onClick={() => setMode("still")}>
          Still
        </button>
        <button aria-pressed={mode === "3d"} disabled={!canTurn} onClick={() => setMode("3d")}>
          Explore in 3D
        </button>
        {entry?.kind === "part" && locate && canLocate(project) && <button onClick={locate}>See it together</button>}
      </div>
      {mode === "still" && showRenders && (
        <div className="render-picker">
          {renders.map((r, i) => (
            <button key={r} aria-label={`View ${i + 1}`} aria-pressed={renderIndex === i} onClick={() => setRenderIndex(i)}>
              {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="dimensions">{entry ? sizeText(entry) : ""}</div>
    </section>
  );
}
