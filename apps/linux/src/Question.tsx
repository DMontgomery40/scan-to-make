import { useEffect, useState } from "react";
import { normalizeQuestion, validateAnswer } from "./domain";
import { openLink } from "./bridge";
import { Action, HoldAction } from "./ui";
import type { RawQuestion } from "./types";
export function Question({
  raw,
  answer,
}: {
  raw: RawQuestion;
  answer: (value: object) => Promise<void>;
}) {
  const q = normalizeQuestion(raw);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      q.fields
        .filter((f) => f.default !== undefined)
        .map((f) => [f.name, f.default]),
    ),
  );
  const [expired, setExpired] = useState(Date.now() >= q.expiresAtMs);
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, q.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [q.expiresAtMs]);
  const update = (name: string, value: unknown) =>
    setValues((v) => ({ ...v, [name]: value }));
  const accept = async () =>
    answer({ action: "accept", content: validateAnswer(q, values) });
  return (
    <section className="question" aria-label="Printer question">
      <div className="eyebrow">Your printer needs an answer</div>
      <h3>{q.message}</h3>
      {expired ? (
        <p>This question expired. Waiting for the current state…</p>
      ) : (
        <>
          {!q.supported ? (
            <p>
              This question uses a format this version cannot answer. You can
              decline or cancel it.
            </p>
          ) : (
            q.fields.map((f) => (
              <label className="field" key={f.name}>
                <span>
                  {f.title}
                  {f.required ? " *" : ""}
                </span>
                {f.description && <small>{f.description}</small>}
                {!f.type || f.type === "boolean" ? (
                  <select
                    value={
                      values[f.name] === undefined ? "" : String(values[f.name])
                    }
                    onChange={(e) =>
                      update(
                        f.name,
                        e.target.value === ""
                          ? undefined
                          : e.target.value === "true",
                      )
                    }
                  >
                    <option value="">Choose…</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : f.enum ? (
                  <select
                    value={String(values[f.name] ?? "")}
                    onChange={(e) => update(f.name, e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {f.enum.map((value, i) => (
                      <option key={value} value={value}>
                        {f.enumNames?.[i] ?? value}
                      </option>
                    ))}
                  </select>
                ) : f.type === "array" ? (
                  <select
                    multiple
                    value={(values[f.name] ?? []) as string[]}
                    onChange={(e) =>
                      update(
                        f.name,
                        [...e.target.selectedOptions].map((o) => o.value),
                      )
                    }
                  >
                    {f.items?.enum?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={String(values[f.name] ?? "")}
                    type={
                      f.type === "integer" || f.type === "number"
                        ? "number"
                        : f.format === "email"
                          ? "email"
                          : f.format === "date"
                            ? "date"
                            : "text"
                    }
                    min={f.minimum}
                    max={f.maximum}
                    step={f.type === "integer" ? 1 : "any"}
                    minLength={f.minLength}
                    maxLength={f.maxLength ?? 4096}
                    onChange={(e) => update(f.name, e.target.value)}
                  />
                )}
              </label>
            ))
          )}
          {q.url && (
            <Action run={() => openLink(q.url!)}>
              Open the printer’s confirmation page
            </Action>
          )}
          <div className="actions">
            <Action run={() => answer({ action: "cancel" })}>Cancel</Action>
            <Action run={() => answer({ action: "decline" })}>Decline</Action>
            {q.supported &&
              (/fulu|firmware|developer mode/i.test(q.message) ? (
                <HoldAction label="Confirm" run={accept} />
              ) : (
                <Action className="primary" run={accept}>
                  Confirm
                </Action>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
