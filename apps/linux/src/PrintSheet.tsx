import { useEffect, useRef, useState } from "react";
import { call } from "./bridge";
import {
  activePrint,
  duration,
  freezePlate,
  guardPlate,
  parseLayers,
} from "./domain";
import { Picture } from "./Stage";
import { Action, Modal } from "./ui";
import type { Estimate, Filament, Printer, Project } from "./types";
export function PrintSheet({
  project,
  printers,
  apply,
  onClose,
}: {
  project: Project;
  printers: Printer[];
  apply: (p: Project) => void;
  onClose: () => void;
}) {
  const frozen = useRef(freezePlate(project)).current;
  const frozenModel = useRef(project.current?.model).current;
  const initial =
    project.settings?.printDefaults ?? project.preferences?.printDefaults ?? {};
  const [destination, setDestination] = useState(
    project.printerDestinationId ?? "",
  );
  const [quality, setQuality] = useState(initial.quality ?? "standard");
  const [strength, setStrength] = useState(initial.strength ?? "standard");
  const [copies, setCopies] = useState(initial.copies ?? 1);
  const [pauses, setPauses] = useState(
    initial.pauseBeforeLayers?.join(", ") ?? "",
  );
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [slot, setSlot] = useState("");
  const [material, setMaterial] = useState("");
  const [estimate, setEstimate] = useState<Estimate>();
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const sequence = useRef(0);
  const printer = printers.find((p) => p.id === destination);
  const caps = printer?.capabilities;
  const plate = project.plates?.find((p) => p.id === frozen);
  const stale =
    freezePlate(project) !== frozen || project.current?.model !== frozenModel;
  useEffect(() => {
    let live = true;
    setFilaments([]);
    setSlot("");
    setEstimate(undefined);
    if (destination)
      void call<{ filaments: Filament[] }>("objects.filaments", {
        id: project.id,
      }).then(
        (r) => {
          if (live) {
            const matching = r.filaments.filter(
              (f) => f.destinationId === destination,
            );
            setFilaments(matching);
            const suggested = matching.find((f) => f.suggested);
            if (suggested) setSlot(String(suggested.slot));
          }
        },
        (e) => {
          if (live) setError(String(e));
        },
      );
    return () => {
      live = false;
    };
  }, [project.id, destination]);
  const changePrinter = async (id: string) => {
    setChanging(true);
    setError("");
    try {
      const result = await call<{ object: Project }>("objects.selectPrinter", {
        id: project.id,
        destinationId: id,
      });
      apply(result.object);
      setDestination(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setChanging(false);
    }
  };
  const options = { destinationId: destination, quality, strength, copies };
  const key = JSON.stringify(options);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    setEstimate(undefined);
    sequence.current++;
  }, [key]);
  const ensureCurrent = async () => {
    const { object } = await call<{ object: Project }>("objects.get", {
      id: project.id,
    });
    guardPlate(object, frozen);
    if (object.current?.model !== frozenModel)
      throw new Error("The model changed. Reopen Print and review it.");
    if (activePrint(object))
      throw new Error(
        "This project already has an active or uncertain print. Review its status first.",
      );
    if (object.printerDestinationId !== destination)
      throw new Error("The printer changed on another device. Reopen Print.");
    return object;
  };
  return (
    <Modal
      title={plate?.status === "printed" ? "Print this plate again" : "Print"}
      onClose={onClose}
      wide
    >
      <div className="print-layout">
        <div>
          <Picture
            id={project.id}
            path={plate?.thumbnail ?? project.current?.renders[0]}
            alt={plate?.name ?? project.title}
            className="print-preview"
          />
          <h3>{plate?.name ?? project.title}</h3>
          {plate && (
            <small>
              {plate.fileName} · {plate.status}
            </small>
          )}
          <p>
            {estimate
              ? `${duration(estimate.seconds)} · ${estimate.grams === undefined ? "Weight unavailable" : `${estimate.grams.toFixed(1)} g`}${estimate.layers ? ` · ${estimate.layers} layers` : ""}`
              : "Estimate this plate with the settings you choose."}
          </p>
          {estimate?.warnings?.map((w) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}
        </div>
        <div className="form">
          <label className="field">
            Printer
            <select
              value={destination}
              disabled={changing}
              onChange={(e) => void changePrinter(e.target.value)}
            >
              <option value="">Choose a printer…</option>
              {!printers.length && (
                <option value="">Add a printer in Settings</option>
              )}
              {printers.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name} · {p.state ?? "Checking"}
                </option>
              ))}
            </select>
          </label>
          <div className="two-columns">
            <label className="field">
              Quality
              <select
                disabled={caps?.quality !== true}
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                <option value="draft">Draft</option>
                <option value="standard">Standard</option>
                <option value="fine">Fine</option>
              </select>
            </label>
            <label className="field">
              Strength
              <select
                disabled={caps?.strength !== true}
                value={strength}
                onChange={(e) => setStrength(e.target.value)}
              >
                <option value="standard">Standard</option>
                <option value="strong">Strong</option>
                <option value="max">Maximum</option>
              </select>
            </label>
          </div>
          <label className="field">
            Copies
            <input
              type="number"
              min={1}
              max={64}
              value={copies}
              disabled={caps?.copies !== true}
              onChange={(e) => setCopies(Number(e.target.value))}
            />
          </label>
          <label className="field">
            Loaded filament
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">Use printer profile</option>
              {filaments.map((f) => (
                <option key={f.slot} value={f.slot}>
                  {f.slot >= 254 ? "External spool" : `Slot ${f.slot + 1}`} ·{" "}
                  {f.material} · {f.name || f.colour}
                </option>
              ))}
            </select>
          </label>
          {slot && (
            <div
              className="swatch"
              style={{
                backgroundColor: filaments.find((f) => String(f.slot) === slot)
                  ?.colour,
              }}
            />
          )}
          {caps?.materialChoice === true && !filaments.length && (
            <label className="field">
              What’s loaded?
              <select
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
              >
                <option value="">Use printer profile</option>
                {["PLA", "PETG", "ABS", "ASA", "TPU"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Pause before layers
            <input
              placeholder="For example: 3, 20"
              value={pauses}
              disabled={caps?.layerPauses !== true || plate?.sliced}
              onChange={(e) => setPauses(e.target.value)}
            />
            <small>
              {plate?.sliced
                ? "The original sliced plate keeps its own pauses."
                : caps?.layerPauses === true
                  ? "Drop in magnets or nuts, then resume from this project."
                  : "This printer MCP has not reported layer-pause support."}
            </small>
          </label>
          <Action
            disabled={!destination || changing || stale}
            run={async () => {
              setError("");
              const ticket = ++sequence.current;
              const submittedKey = key;
              await ensureCurrent();
              const value = await call<Estimate>("objects.estimate", {
                id: project.id,
                ...options,
              });
              await ensureCurrent();
              if (
                ticket === sequence.current &&
                currentKey.current === submittedKey
              )
                setEstimate(value);
            }}
            onError={setError}
          >
            Estimate time & material
          </Action>
        </div>
      </div>
      {stale && (
        <p role="alert" className="error">
          The plate or model changed on another device. Close Print and review
          the current selection.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <Action
          className="primary"
          disabled={!destination || changing || stale || activePrint(project)}
          onError={setError}
          run={async () => {
            await ensureCurrent();
            if (!Number.isInteger(copies) || copies < 1 || copies > 64)
              throw new Error("Choose 1 to 64 copies.");
            const pauseBeforeLayers = parseLayers(pauses, estimate?.layers);
            const filament = filaments.find((f) => String(f.slot) === slot);
            const result = await call<{ object: Project }>("objects.print", {
              id: project.id,
              ...(frozen ? { expectedPlate: frozen } : {}),
              quality,
              strength,
              copies,
              ...(filament
                ? { filament }
                : material
                  ? { colour: { material } }
                  : {}),
              ...(pauseBeforeLayers.length ? { pauseBeforeLayers } : {}),
            });
            apply(result.object);
            onClose();
          }}
        >
          Print on {printer?.name ?? "printer"}
        </Action>
      </div>
    </Modal>
  );
}
