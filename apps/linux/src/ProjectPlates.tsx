import { useState } from "react";
import { canSelectPlate, plateStatusText } from "./domain";
import { Picture } from "./Stage";
import { Action, Modal } from "./ui";
import type { Project } from "./types";

/** A plate's own completion, including work the person printed in another app. */
export function ProjectPlates({
  project: p,
  mutate,
}: {
  project: Project;
  mutate: (method: string, params: object) => Promise<unknown>;
}) {
  const [error, setError] = useState("");
  const [recording, setRecording] = useState<NonNullable<Project["plates"]>[number]>();
  return (
    <>
      <h3>
        {(p.plates ?? []).filter((x) => x.completedAtMs !== undefined).length} of{" "}
        {(p.plates ?? []).length} plates printed
      </h3>
      <div>
        {(p.plates ?? []).map((plate) => (
          <div key={plate.id} className="plate-record">
            <button
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
              <Picture id={p.id} path={plate.thumbnail} alt={plate.name} />
              <strong>{plate.name}</strong>
              <small>{plate.fileName}</small>
              <span>{plateStatusText(plate)}</span>
            </button>
            {plate.status !== "printed" && plate.completedAtMs == null && (
              <button aria-label={`I printed this elsewhere, ${plate.name}`} disabled={!canSelectPlate(p)} onClick={() => setRecording(plate)}>
                I printed this elsewhere
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="plate-undo">
        {p.plates?.filter(plate => plate.status === "printed" || plate.completedAtMs != null).map(plate => (
          <Action key={plate.id} disabled={!canSelectPlate(p)} run={() => mutate("objects.markPlateNotPrinted", {id:p.id,plateId:plate.id})}>
            Mark {plate.name} not printed
          </Action>
        ))}
      </div>
      {recording && <Modal title={`Mark ${recording.name} as printed elsewhere?`} onClose={() => setRecording(undefined)}>
        <p>{recording.fileName}</p>
        <Action disabled={!canSelectPlate(p)} run={async () => {
          await mutate("objects.markPlatePrinted", {id:p.id,plateId:recording.id});
          setRecording(undefined);
        }}>Mark as printed</Action>
        <button onClick={() => setRecording(undefined)}>Cancel</button>
      </Modal>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
