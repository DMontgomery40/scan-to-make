import { useEffect, useRef, useState } from "react";
import { call } from "./bridge";
import {
  activePrint,
  chosenSpools,
  mixesFeeds,
  partNote,
  proposedSlots,
  spoolTitle,
  duration,
  estimateRequest,
  freezePlate,
  offeredChoices,
  guardPlate,
  parseLayers,
  printRequest,
  shownSlice,
  startingChoices,
  designerSettingsWords,
} from "./domain";
import { Action, Modal } from "./ui";
import type { ColourMapping, Estimate, Filament, Printer, Project } from "./types";
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
  const initial = startingChoices(project);
  const [destination, setDestination] = useState(
    project.printerDestinationId ?? "",
  );
  const [quality, setQuality] = useState(initial.quality ?? "standard");
  const [strength, setStrength] = useState(initial.strength ?? "standard");
  // Chosen in this sheet; until then a designer's file starts at its own settings, even when the MCP's answer
  // arrives after the sheet opened (as on the Mac and iPhone).
  const [qualityPicked, setQualityPicked] = useState(false);
  const [strengthPicked, setStrengthPicked] = useState(false);
  const ownSettings = project.current?.ownSettings === true;
  useEffect(() => {
    if (ownSettings && !qualityPicked) setQuality("standard");
    if (ownSettings && !strengthPicked) setStrength("standard");
  }, [ownSettings, qualityPicked, strengthPicked]);
  const [copies, setCopies] = useState(initial.copies ?? 1);
  const [pauses, setPauses] = useState(
    initial.pauseBeforeLayers?.join(", ") ?? "",
  );
  const [filaments, setFilaments] = useState<Filament[]>([]);
  // A multi-colour model: each part's spool, as the printer MCP proposes it (`objects.colourMapping`).
  const [mapping, setMapping] = useState<ColourMapping>();
  const [mappingSlots, setMappingSlots] = useState<Record<number, number>>({});
  // Until the mapping answers, nothing slices: an estimate without its per-part spools would print one colour.
  const [mappingLoaded, setMappingLoaded] = useState(false);
  const [mappingProblem, setMappingProblem] = useState("");
  const [mappingAttempt, setMappingAttempt] = useState(0);
  const [slot, setSlot] = useState("");
  const [material, setMaterial] = useState("");
  const [estimate, setEstimate] = useState<Estimate>();
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const sequence = useRef(0);
  const printer = printers.find((p) => p.id === destination);
  const caps = printer?.capabilities;
  const plate = project.plates?.find((p) => p.id === frozen);
  const stale =
    freezePlate(project) !== frozen || project.current?.model !== frozenModel;
  // The colours, once the printer is chosen: until they answer, nothing slices or prints. A failure stays a
  // failure (the companion's own words) with Try Again, so a timeout or a since-updated MCP never strands the sheet.
  useEffect(() => {
    let live = true;
    setMapping(undefined);
    setMappingSlots({});
    setMappingLoaded(false);
    setMappingProblem("");
    if (destination)
      void call<ColourMapping>("objects.colourMapping", { id: project.id }).then(
        (r) => {
          if (live && r.filaments.length) {
            setMapping(r);
            setMappingSlots(proposedSlots(r));
          }
          if (live) setMappingLoaded(true);
        },
        (e) => {
          // A refusal (such as "Update bambu-printer-mcp…") is shown and holds Print: it never prints one colour instead.
          if (live) setMappingProblem(String(e));
        },
      );
    return () => {
      live = false;
    };
  }, [project.id, destination, mappingAttempt]);
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
  // Every choice Print makes: the estimate slices exactly these (Nov 5), so changing one slices again.
  let pausesProblem = "";
  let pauseBeforeLayers: number[] = [];
  try {
    pauseBeforeLayers = parseLayers(pauses);
  } catch (e) {
    pausesProblem = e instanceof Error ? e.message : String(e);
  }
  const offers = (choice: string) => !plate?.sliced && caps?.[choice] === true;
  const choices = offeredChoices(
    {
      destinationId: destination,
      quality,
      strength,
      copies,
      ...(mapping
        ? { spools: chosenSpools(mapping, mappingSlots), modelVersion: mapping.modelVersion }
        : { filament: filaments.find((f) => String(f.slot) === slot), material: material || undefined }),
      pauseBeforeLayers,
    },
    {
      capabilities: caps,
      sliced: !!plate?.sliced,
      savedCopies: initial.copies !== undefined,
    },
  );
  const key = JSON.stringify(choices);
  const currentKey = useRef(key);
  currentKey.current = key;
  const shown = shownSlice(estimate);
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
  const runEstimate = async () => {
    setError("");
    const ticket = ++sequence.current;
    const submittedKey = key;
    setEstimating(true);
    try {
      await ensureCurrent();
      const value = await call<Estimate>(
        "objects.estimate",
        estimateRequest(project.id, choices),
      );
      await ensureCurrent();
      if (ticket === sequence.current && currentKey.current === submittedKey)
        setEstimate(value);
    } finally {
      if (ticket === sequence.current) setEstimating(false);
    }
  };
  const ready =
    !!destination &&
    !changing &&
    !stale &&
    !(offers("layerPauses") && pausesProblem) &&
    mappingLoaded &&
    // A multi-colour model prints only with a spool for every part, from one feed.
    !(mapping && (!chosenSpools(mapping, mappingSlots) || mixesFeeds(mapping, mappingSlots))) &&
    (!offers("copies") ||
      (Number.isInteger(copies) && copies >= 1 && copies <= 64));
  useEffect(() => {
    setEstimate(undefined);
    setEstimating(false);
    sequence.current++;
    if (!ready) return;
    const timer = setTimeout(
      () =>
        void runEstimate().catch((e) =>
          setError(e instanceof Error ? e.message : String(e)),
        ),
      600,
    );
    return () => clearTimeout(timer);
  }, [key, ready]);
  return (
    <Modal
      title={plate?.status === "printed" ? "Print this plate again" : "Print"}
      onClose={onClose}
      wide
    >
      <div className="print-layout">
        <div>
          {/* What will print (Nov 5): the printer MCP's pictures of the exact sliced file Print sends, never a
              design render or a thumbnail the file carried along. */}
          <section className="what-will-print" aria-label="What will print">
            <h3>What will print</h3>
            {shown && estimate?.preview ? (
              <>
                {estimate.preview.views.map((view) => (
                  <figure key={view.name}>
                    <img
                      className="print-preview"
                      src={`data:image/png;base64,${view.png}`}
                      alt={view.label}
                      width={view.width}
                      height={view.height}
                    />
                    <figcaption>{view.label}</figcaption>
                  </figure>
                ))}
                <small>Drawn from the sliced file Print sends.</small>
              </>
            ) : estimating ? (
              <p>Slicing it to show you…</p>
            ) : estimate ? (
              <p>
                Update {printer?.backend || "your printer service"} in Settings
                → Printers so Counterpart can show you what will print.
              </p>
            ) : (
              <p>Nothing to show yet.</p>
            )}
          </section>
          <h4>{plate?.name ?? project.title}</h4>
          {plate && (
            <small>
              {plate.fileName} · {plate.status}
            </small>
          )}
          <p>
            {estimate
              ? `${duration(estimate.seconds)} · ${estimate.grams === undefined ? "Weight unavailable" : `${estimate.grams.toFixed(1)} g`}${estimate.layers ? ` · ${estimate.layers} layers` : ""}`
              : estimating
                ? "Slicing with the settings you chose…"
                : "Choose a printer and settings to slice this plate."}
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
                onChange={(e) => {
                  setQuality(e.target.value);
                  setQualityPicked(true);
                }}
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
                onChange={(e) => {
                  setStrength(e.target.value);
                  setStrengthPicked(true);
                }}
              >
                <option value="standard">Standard</option>
                <option value="strong">Strong</option>
                <option value="max">Maximum</option>
              </select>
            </label>
          </div>
          {designerSettingsWords(project, quality, strength) && (
            <p className="hint">{designerSettingsWords(project, quality, strength)}</p>
          )}
          {estimate?.ownSettingsUpdate && <p className="hint">{estimate.ownSettingsUpdate}</p>}
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
          {mapping && (
            <fieldset className="field">
              <legend>Colours</legend>
              {mapping.filaments.map((part) => (
                <label className="field" key={part.index}>
                  <span>
                    <span className="swatch" style={{ backgroundColor: part.colour ?? "#808080" }} />{" "}
                    {part.name ?? `Part ${part.index}`}
                  </span>
                  <select
                    aria-label={`Spool for ${part.name ?? `part ${part.index}`}`}
                    value={mappingSlots[part.index] ?? ""}
                    onChange={(e) =>
                      setMappingSlots((s) => ({ ...s, [part.index]: Number(e.target.value) }))
                    }
                  >
                    {mappingSlots[part.index] === undefined && <option value="">Choose a spool</option>}
                    {mapping.trays.map((t) => (
                      <option key={t.slot} value={t.slot}>
                        {spoolTitle(t)}
                      </option>
                    ))}
                  </select>
                  {partNote(mapping, part, mappingSlots) && <small>{partNote(mapping, part, mappingSlots)}</small>}
                </label>
              ))}
              {mixesFeeds(mapping, mappingSlots) && (
                <p className="hint">One print feeds from one source: put every colour on AMS spools, or every colour on the external spool.</p>
              )}
            </fieldset>
          )}
          {!mapping && (<>
          <label className="field">
            Loaded filament
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">Use printer profile</option>
              {filaments.map((f) => (
                <option key={f.slot} value={f.slot}>
                  {/* The printer MCP's words: "A2 · Sunflower Yellow PLA Basic". */}
                  {f.label ? `${f.label} · ${f.name}` : `${f.material} · ${f.name || f.colour}`}
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
          </>)}
          <label className="field">
            Pause before layers
            <input
              placeholder="For example: 3, 20"
              value={pauses}
              disabled={caps?.layerPauses !== true || plate?.sliced}
              onChange={(e) => setPauses(e.target.value)}
            />
            {pausesProblem && <small className="error">{pausesProblem}</small>}
            <small>
              {plate?.sliced
                ? "The original sliced plate keeps its own pauses."
                : caps?.layerPauses === true
                  ? "Drop in magnets or nuts, then resume from this project."
                  : "This printer MCP has not reported layer-pause support."}
            </small>
          </label>
          <Action
            disabled={!ready || estimating}
            run={runEstimate}
            onError={setError}
          >
            Slice again
          </Action>
        </div>
      </div>
      {stale && (
        <p role="alert" className="error">
          The plate or model changed on another device. Close Print and review
          the current selection.
        </p>
      )}
      {mappingProblem && (
        <p role="alert" className="error">
          {mappingProblem}{" "}
          <button onClick={() => setMappingAttempt((n) => n + 1)}>
            Try Again
          </button>
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
          disabled={!ready || estimating || !shown || activePrint(project)}
          onError={setError}
          run={async () => {
            await ensureCurrent();
            if (offers("layerPauses")) parseLayers(pauses, estimate?.layers);
            if (!shown || currentKey.current !== key)
              throw new Error("Open Print to see what will print.");
            const result = await call<{ object: Project }>(
              "objects.print",
              printRequest(project.id, choices, shown, frozen),
            );
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
