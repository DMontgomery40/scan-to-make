import { useState } from "react";
import { canSelectPlate, plateStatusText } from "./domain";
import { Picture } from "./Stage";
import { Action } from "./ui";
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
  return (
    <>
      <h3>
        {(p.plates ?? []).filter((x) => x.status === "printed").length} of{" "}
        {(p.plates ?? []).length} plates printed
      </h3>
      <div>
        {(p.plates ?? []).map((plate) => (
          <div key={plate.id}>
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
            {plate.status !== "printed" && (
              <Action
                label={`I printed this elsewhere, ${plate.name}`}
                disabled={!canSelectPlate(p)}
                run={() =>
                  mutate("objects.markPlatePrinted", {
                    id: p.id,
                    plateId: plate.id,
                  })
                }
              >
                I printed this elsewhere
              </Action>
            )}
          </div>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
