import { useEffect, useMemo, useRef, useState } from "react";
import { call, reconstructionPreview } from "./bridge";
import {
  buildRegionAnswer,
  buildScaleAnswer,
  componentWords,
  formatExtents,
  formatPreviewExtent,
  parseExtentMm,
  selectionBox,
  type Axis,
} from "./domain";
import { Action } from "./ui";
import type {
  Project,
  ReconstructionReview as Review,
  ReconstructionSelection,
  Vec3,
} from "./types";

type Box = { min: Vec3; max: Vec3 };
const AXES: Axis[] = ["x", "y", "z"];
const AXIS_NAME: Record<Axis, string> = {
  x: "X (highlighted side)",
  y: "Y (highlighted side)",
  z: "Z (highlighted side)",
};

/** Three.js preview in raw preview coordinates, with the chosen part lit amber. */
function ReviewStage({
  bytes,
  highlight,
  scaleAxis,
  boundsMin,
  boundsMax,
}: {
  bytes: Uint8Array;
  highlight?: Box;
  scaleAxis?: Axis;
  boundsMin: Vec3;
  boundsMax: Vec3;
}) {
  const element = useRef<HTMLDivElement>(null);
  const action = useRef<(a: string) => void>(() => {});
  const update = useRef<(box?: Box, axis?: Axis) => void>(() => {});
  const latest = useRef<{ box?: Box; axis?: Axis }>({
    box: highlight,
    axis: scaleAxis,
  });
  latest.current = { box: highlight, axis: scaleAxis };
  const [error, setError] = useState("");
  useEffect(() => {
    update.current(highlight, scaleAxis);
  }, [highlight, scaleAxis]);
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
          const position = geometry.getAttribute("position");
          if (!position?.count)
            throw new Error("This preview has no viewable geometry.");
          geometry.computeVertexNormals();
          const lo = new T.Vector3(...boundsMin);
          const hi = new T.Vector3(...boundsMax);
          const centre = lo.clone().add(hi).multiplyScalar(0.5);
          const span = hi.clone().sub(lo);
          const radius = Math.max(span.x, span.y, span.z);
          if (!Number.isFinite(radius) || radius <= 0)
            throw new Error("This preview has invalid dimensions.");
          renderer = new T.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: "low-power",
          });
          renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
          renderer.setClearColor(0x11150f, 1);
          renderer.outputColorSpace = T.SRGBColorSpace;
          const canvas = renderer.domElement;
          canvas.setAttribute(
            "aria-label",
            "3D reconstruction preview. The selected part is amber. Drag to orbit, scroll to zoom, or use the buttons below.",
          );
          canvas.setAttribute("role", "img");
          canvas.setAttribute("data-testid", "reconstruction-canvas");
          element.current.replaceChildren(canvas);
          const scene = new T.Scene();
          scene.background = new T.Color(0x11150f);
          const group = new T.Group();
          group.position.copy(centre).multiplyScalar(-1);
          scene.add(group);
          const colors = new Float32Array(position.count * 3);
          geometry.setAttribute("color", new T.BufferAttribute(colors, 3));
          const material = new T.MeshStandardMaterial({
            vertexColors: true,
            metalness: 0.05,
            roughness: 0.65,
            side: T.DoubleSide,
          });
          group.add(new T.Mesh(geometry, material));
          const helpers = new T.Group();
          group.add(helpers);
          const clearHelpers = () => {
            helpers.traverse((object) => {
              if (object instanceof T.Mesh || object instanceof T.Line) {
                object.geometry.dispose();
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach((item) => item.dispose());
              }
            });
            helpers.clear();
          };
          scene.add(new T.HemisphereLight(0xffffff, 0x4e5b57, 1.5));
          const light = new T.DirectionalLight(0xffffff, 2.2);
          light.position.set(radius * 2, radius * 3, radius * 2);
          scene.add(light);
          const camera = new T.PerspectiveCamera(
            36,
            1,
            radius / 1000,
            radius * 100,
          );
          const home = () =>
            camera.position.set(radius * 1.4, radius * 1.1, radius * 1.8);
          home();
          const controls = new OrbitControls(camera, canvas);
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
          const inside = [0.45, 0.72, 0.35];
          const amber = [1, 0.62, 0.08];
          const dim = [0.32, 0.38, 0.3];
          update.current = (box, axis) => {
            const eps = radius * 1e-4;
            for (let tri = 0; tri < position.count; tri += 3) {
              let r = inside[0]!, g = inside[1]!, b = inside[2]!;
              if (box) {
                const cx =
                  (position.getX(tri) + position.getX(tri + 1) + position.getX(tri + 2)) / 3;
                const cy =
                  (position.getY(tri) + position.getY(tri + 1) + position.getY(tri + 2)) / 3;
                const cz =
                  (position.getZ(tri) + position.getZ(tri + 1) + position.getZ(tri + 2)) / 3;
                const hit =
                  cx >= box.min[0] - eps && cx <= box.max[0] + eps &&
                  cy >= box.min[1] - eps && cy <= box.max[1] + eps &&
                  cz >= box.min[2] - eps && cz <= box.max[2] + eps;
                [r, g, b] = hit ? amber : dim;
              }
              for (let v = 0; v < 3; v++) {
                colors[(tri + v) * 3] = r;
                colors[(tri + v) * 3 + 1] = g;
                colors[(tri + v) * 3 + 2] = b;
              }
            }
            geometry.getAttribute("color").needsUpdate = true;
            clearHelpers();
            if (box) {
              const size = new T.Vector3(
                box.max[0] - box.min[0],
                box.max[1] - box.min[1],
                box.max[2] - box.min[2],
              );
              const mid = new T.Vector3(
                (box.min[0] + box.max[0]) / 2,
                (box.min[1] + box.max[1]) / 2,
                (box.min[2] + box.max[2]) / 2,
              );
              const boxGeometry = new T.BoxGeometry(size.x, size.y, size.z);
              const edgeGeometry = new T.EdgesGeometry(boxGeometry);
              boxGeometry.dispose();
              const edges = new T.LineSegments(
                edgeGeometry,
                new T.LineBasicMaterial({ color: 0xffb020 }),
              );
              edges.position.copy(mid);
              helpers.add(edges);
            }
            if (axis) {
              const i = AXES.indexOf(axis);
              const start = [...boundsMin] as Vec3;
              const end = [...boundsMin] as Vec3;
              end[i] = boundsMax[i]!;
              // Offset the measured side just outside the model on the other axes.
              for (let j = 0; j < 3; j++)
                if (j !== i) {
                  start[j] = boundsMin[j]! - radius * 0.08;
                  end[j] = start[j]!;
                }
              const points = [
                new T.Vector3(...start),
                new T.Vector3(...end),
              ];
              const line = new T.Line(
                new T.BufferGeometry().setFromPoints(points),
                new T.LineBasicMaterial({ color: 0xffb020 }),
              );
              helpers.add(line);
              for (const p of points) {
                const cap = new T.Mesh(
                  new T.SphereGeometry(radius * 0.035, 10, 8),
                  new T.MeshBasicMaterial({ color: 0xffb020 }),
                );
                cap.position.copy(p);
                helpers.add(cap);
              }
            }
            render();
          };
          update.current(latest.current.box, latest.current.axis);
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
          cleanup = () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener("visibilitychange", render);
            controls.dispose();
            clearHelpers();
            geometry.dispose();
            material.dispose();
            renderer?.dispose();
            renderer?.forceContextLoss();
            canvas.remove();
            action.current = () => {};
            update.current = () => {};
          };
        } catch (e) {
          renderer?.dispose();
          setError(
            e instanceof Error ? e.message : "3D preview unavailable here.",
          );
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      cleanup();
    };
    // Bounds travel with the preview bytes for one review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);
  return (
    <div className="review-view">
      <div className="review-canvas" ref={element} />
      {error && (
        <p role="alert" className="error">
          {error} You can still answer from the sizes below, or refresh the
          review.
        </p>
      )}
      <div className="orbit-tools review-tools" aria-label="3D view controls">
        <button onClick={() => action.current("left")} aria-label="Orbit left">↶</button>
        <button onClick={() => action.current("right")} aria-label="Orbit right">↷</button>
        <button onClick={() => action.current("in")} aria-label="Zoom in">+</button>
        <button onClick={() => action.current("out")} aria-label="Zoom out">−</button>
        <button onClick={() => action.current("reset")}>Reset view</button>
      </div>
    </div>
  );
}

export function ReconstructionReviewCard({
  project,
  review,
  mutate,
  apply,
}: {
  project: Project;
  review: Review;
  mutate: (method: string, params?: object) => Promise<{ object?: Project }>;
  apply: (p: Project) => void;
}) {
  const [bytes, setBytes] = useState<Uint8Array>();
  const [previewError, setPreviewError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<ReconstructionSelection["type"]>(
    review.suggestion ? "suggested" : review.components?.length ? "component" : "crop",
  );
  const [componentIndex, setComponentIndex] = useState(
    review.components?.[0]?.index ?? 0,
  );
  const initialCrop = useMemo<Box>(() => {
    const suggested = selectionBox(review, { type: "suggested" });
    const first = review.components?.[0];
    return (
      suggested ??
      (first
        ? { min: first.boundsMin, max: first.boundsMax }
        : { min: review.boundsMin, max: review.boundsMax })
    );
  }, [review]);
  const [cropMin, setCropMin] = useState<Vec3>(initialCrop.min);
  const [cropMax, setCropMax] = useState<Vec3>(initialCrop.max);
  const [axis, setAxis] = useState<Axis>("x");
  const [extentText, setExtentText] = useState("");
  const [measured, setMeasured] = useState(false);
  useEffect(() => {
    let live = true;
    setBytes(undefined);
    setPreviewError("");
    void reconstructionPreview(project.id, review.id).then(
      (data) => {
        if (live) setBytes(data);
      },
      (e) => {
        if (live)
          setPreviewError(
            `${String(e)} Refresh the review; nothing was answered.`,
          );
      },
    );
    return () => {
      live = false;
    };
  }, [project.id, review.id, retry]);
  const refresh = async () => {
    setNotice("");
    const result = await call<{ object: Project }>("objects.get", {
      id: project.id,
    });
    apply(result.object);
    if (result.object.reconstructionReview?.id === review.id) setRetry((n) => n + 1);
    else
      setNotice(
        "That review was answered or replaced elsewhere. This is the current question now.",
      );
  };
  const selection: ReconstructionSelection =
    mode === "suggested"
      ? { type: "suggested" }
      : mode === "component"
        ? { type: "component", index: componentIndex }
        : { type: "crop", min: cropMin, max: cropMax };
  const highlight =
    review.kind === "region" ? selectionBox(review, selection) : undefined;
  const answer = async () => {
    setNotice("");
    try {
      const value =
        review.kind === "region"
          ? buildRegionAnswer(review, selection)
          : buildScaleAnswer(review, axis, parseExtentMm(extentText));
      await mutate("objects.answerReconstruction", {
        id: project.id,
        reviewId: review.id,
        answer: value,
      });
    } catch (e) {
      // A refused/stale answer is explained and the current review re-read; never accepted silently.
      setNotice(`${String(e)} Nothing was accepted from that answer.`);
      try {
        const result = await call<{ object: Project }>("objects.get", {
          id: project.id,
        });
        apply(result.object);
      } catch {
        /* the refusal above stays visible */
      }
      throw new Error("Answer not accepted — see the note above.");
    }
  };
  const setCrop = (which: "min" | "max", i: number, raw: string) => {
    const value = Number(raw);
    const updateVec = (vec: Vec3): Vec3 => {
      const next = [...vec] as Vec3;
      next[i] = value;
      return next;
    };
    if (which === "min") setCropMin((v) => updateVec(v));
    else setCropMax((v) => updateVec(v));
  };
  return (
    <section className="question reconstruction" aria-label="Reconstruction review">
      <div className="eyebrow">Needs you · scan review</div>
      <h3>
        {review.kind === "region"
          ? "Which part of this model is the object you scanned?"
          : "How big is the object?"}
      </h3>
      <p>
        {review.kind === "region"
          ? "The amber part is what will be kept. Check it in 3D, change it if needed, then confirm."
          : "Measure the marked side on the real object, enter it in millimetres, then confirm."}{" "}
        Whole preview: {formatExtents(review, review.extents)}.
        {!review.scaleKnown &&
          " Preview units are the rebuild's own coordinates — they are not millimetres."}
      </p>
      {notice && (
        <p role="alert" className="error">
          {notice}
        </p>
      )}
      {previewError ? (
        <div className="notice">
          <p role="alert">{previewError}</p>
          <Action run={refresh}>Refresh review</Action>
        </div>
      ) : bytes ? (
        <ReviewStage
          bytes={bytes}
          highlight={highlight}
          scaleAxis={review.kind === "scale" ? axis : undefined}
          boundsMin={review.boundsMin}
          boundsMax={review.boundsMax}
        />
      ) : (
        <p>Opening the 3D preview…</p>
      )}
      {review.kind === "region" ? (
        <div className="review-controls">
          {review.suggestion && (
            <label className="choice">
              <input
                type="radio"
                name="reconstruction-selection"
                checked={mode === "suggested"}
                onChange={() => setMode("suggested")}
              />
              <span>
                Suggested part
                <small>
                  {review.suggestion.reason} Size:{" "}
                  {formatExtents(review, review.suggestion.extents)}.
                  {!highlight && mode === "suggested"
                    ? " Its exact boundary is applied by the rebuild and is not drawn here."
                    : ""}
                </small>
              </span>
            </label>
          )}
          {review.components?.map((c) => (
            <label className="choice" key={c.index}>
              <input
                type="radio"
                name="reconstruction-selection"
                checked={mode === "component" && componentIndex === c.index}
                onChange={() => {
                  setMode("component");
                  setComponentIndex(c.index);
                }}
              />
              <span>
                {componentWords(c)}
                <small>Size: {formatExtents(review, c.extents)}</small>
              </span>
            </label>
          ))}
          <label className="choice">
            <input
              type="radio"
              name="reconstruction-selection"
              checked={mode === "crop"}
              onChange={() => setMode("crop")}
            />
            <span>
              Keep a box I set
              <small>Drag the bounds; only geometry inside the amber box is kept.</small>
            </span>
          </label>
          {mode === "crop" && (
            <div className="crop-grid">
              {AXES.map((a, i) => {
                const lo = review.boundsMin[i]!;
                const hi = review.boundsMax[i]!;
                const step = (hi - lo) / 200 || 0.001;
                return (
                  <fieldset key={a}>
                    <legend>{AXIS_NAME[a]}</legend>
                    {(["min", "max"] as const).map((which) => {
                      const value = which === "min" ? cropMin[i]! : cropMax[i]!;
                      return (
                        <label className="field crop-field" key={which}>
                          {a.toUpperCase()} {which} (preview units)
                          <input
                            type="range"
                            aria-label={`${a.toUpperCase()} ${which}`}
                            min={lo}
                            max={hi}
                            step={step}
                            value={Number.isFinite(value) ? value : lo}
                            onChange={(e) => setCrop(which, i, e.target.value)}
                          />
                          <input
                            type="number"
                            aria-label={`${a.toUpperCase()} ${which} value`}
                            step="any"
                            value={Number.isFinite(value) ? value : ""}
                            onChange={(e) => setCrop(which, i, e.target.value)}
                          />
                        </label>
                      );
                    })}
                  </fieldset>
                );
              })}
              <p>
                Kept box:{" "}
                {AXES.map((a, i) =>
                  formatPreviewExtent(review, cropMax[i]! - cropMin[i]!),
                ).join(" × ")}
              </p>
            </div>
          )}
          <Action className="primary" run={answer}>
            Confirm this part
          </Action>
        </div>
      ) : (
        <div className="review-controls">
          {AXES.map((a) => (
            <label className="choice" key={a}>
              <input
                type="radio"
                name="reconstruction-axis"
                checked={axis === a}
                onChange={() => setAxis(a)}
              />
              <span>
                Measure the {AXIS_NAME[a]} side
                <small>
                  Marked amber in the preview ·{" "}
                  {formatPreviewExtent(review, review.extents[a])} in the model
                </small>
              </span>
            </label>
          ))}
          <label className="field">
            That side on the real object (mm)
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={10000}
              step="any"
              value={extentText}
              onChange={(e) => setExtentText(e.target.value)}
              placeholder="e.g. 82.5"
            />
            <small>Between 1 and 10,000 mm. The whole model scales from this one side.</small>
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={measured}
              onChange={(e) => setMeasured(e.target.checked)}
            />
            <span>I measured this side on the real object.</span>
          </label>
          <Action className="primary" disabled={!measured} run={answer}>
            Confirm this size
          </Action>
        </div>
      )}
      <Action run={refresh}>Refresh review</Action>
    </section>
  );
}
