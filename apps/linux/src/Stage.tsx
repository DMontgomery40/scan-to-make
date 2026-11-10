import { useEffect, useRef, useState } from "react";
import { artifact } from "./bridge";
import type { Project } from "./types";
export function Picture({
  id,
  path,
  alt,
  className = "",
  onFailed,
}: {
  id: string;
  path?: string;
  alt: string;
  className?: string;
  /** Called when the picture can't be fetched or decoded, so a caller can hide what it framed (review F2 on #456). */
  onFailed?: () => void;
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
      {failed ? "Preview unavailable" : path ? "Loading preview…" : "◇"}
    </div>
  );
}
export function ModelStage({ bytes }: { bytes: Uint8Array }) {
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
        try {
          const geometry = new STLLoader().parse(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
          if (!geometry.getAttribute("position")?.count)
            throw new Error("This STL has no viewable geometry.");
          geometry.computeBoundingBox();
          const box = geometry.boundingBox!;
          const centre = box.getCenter(new T.Vector3());
          geometry.translate(-centre.x, -centre.y, -centre.z);
          geometry.computeVertexNormals();
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
          const material = new T.MeshStandardMaterial({
            color: 0x809778,
            metalness: 0.08,
            roughness: 0.6,
            side: T.DoubleSide,
          });
          const mesh = new T.Mesh(geometry, material);
          mesh.rotation.x = -Math.PI / 2;
          scene.add(mesh);
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
            `${(geometry.getAttribute("position").count / 3) | 0} triangles · WebGL 2 · ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`,
          );
          cleanup = () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener("visibilitychange", render);
            controls.dispose();
            geometry.dispose();
            material.dispose();
            renderer?.dispose();
            renderer?.forceContextLoss();
            canvas.remove();
            action.current = () => {};
          };
        } catch (e) {
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
  }, [bytes]);
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
export function Stage({ project }: { project: Project }) {
  const [mode, setMode] = useState<"still" | "3d">("still");
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState("");
  const [renderIndex, setRenderIndex] = useState(0);
  const model = project.current?.model;
  const renders = project.current?.renders ?? [];
  const path = renders[renderIndex] ?? renders[0] ?? project.credit?.thumbnail;
  useEffect(() => {
    setMode("still");
    setBytes(undefined);
    setError("");
    setRenderIndex(0);
  }, [project.id, model, project.passes.at(-1)?.endedAtMs]);
  useEffect(() => {
    if (mode !== "3d" || !model) return;
    let live = true;
    void artifact(project.id, model).then(
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
  }, [mode, model, project.id]);
  return (
    <section className="stage" aria-label="Project preview">
      {mode === "3d" ? (
        bytes ? (
          <ModelStage bytes={bytes} />
        ) : (
          <p>{error || "Opening model…"}</p>
        )
      ) : (
        <Picture
          id={project.id}
          path={path}
          alt={`${project.title} preview`}
          className="hero-picture"
        />
      )}
      <div className="stage-switch">
        <button
          aria-pressed={mode === "still"}
          onClick={() => setMode("still")}
        >
          Still
        </button>
        <button
          aria-pressed={mode === "3d"}
          disabled={!model?.toLowerCase().endsWith(".stl")}
          onClick={() => setMode("3d")}
        >
          Explore in 3D
        </button>
      </div>
      {mode === "still" && renders.length > 1 && (
        <div className="render-picker">
          {renders.map((r, i) => (
            <button
              key={r}
              aria-label={`View ${i + 1}`}
              aria-pressed={renderIndex === i}
              onClick={() => setRenderIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="dimensions">
        {project.current?.sizeMm
          ?.map((n) =>
            n.toLocaleString(undefined, { maximumFractionDigits: 2 }),
          )
          .join(" × ")}
        {project.current?.sizeMm ? " mm" : ""}
      </div>
    </section>
  );
}
