import type { Field, Project, Question, RawQuestion } from "./types";
/** Issue tickets before reads AND mutations. Late reads cannot roll the UI back. */
export class ReadOrder {
  private issued = 0;
  private accepted = 0;
  begin() {
    return ++this.issued;
  }
  invalidate() {
    this.accepted = ++this.issued;
  }
  accept(ticket: number) {
    if (ticket < this.accepted) return false;
    this.accepted = ticket;
    return true;
  }
}
export function freezePlate(project: Project) {
  return project.plates?.find((p) => p.selected)?.id;
}
export function guardPlate(project: Project, frozen: string | undefined) {
  if (freezePlate(project) !== frozen)
    throw new Error(
      "The selected plate changed on another device. Close Print and review the plate again.",
    );
  if (project.kind === "published" && !frozen)
    throw new Error("Choose a plate before printing.");
}
export function searchProject(p: Project, query: string) {
  return [
    p.title,
    p.instructions,
    p.status?.text,
    p.failure,
    p.current?.summary,
    p.credit?.designer,
    p.credit?.title,
    p.credit?.licence,
    ...(p.messages ?? []).map((x) => x.text),
    ...p.passes.flatMap((x) => [x.note, x.summary]),
    ...(p.current?.changes ?? []).map((x) => x.text),
    ...(p.plates ?? []).map((x) => x.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}
export function parseLayers(text: string, total?: number) {
  if (!text.trim()) return [];
  const parts = text.split(",").map((x) => x.trim());
  if (parts.length > 16 || parts.some((x) => !/^\d+$/.test(x)))
    throw new Error("Enter up to 16 whole layer numbers separated by commas.");
  const layers = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  if (
    layers.some(
      (x) => x < 2 || x > 100000 || (total !== undefined && x > total),
    )
  )
    throw new Error(
      `Pauses must be before layer 2${total ? ` through ${total}` : " or later"}.`,
    );
  return layers;
}
export function normalizeQuestion(raw: RawQuestion): Question {
  if (raw.fields)
    return {
      ...raw,
      fields: raw.fields,
      supported: raw.supported === true && raw.fields.every(supportedField),
    };
  const schema = raw.requestedSchema as
    | {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      }
    | undefined;
  let supported =
    schema?.type === "object" &&
    !!schema.properties &&
    Object.values(schema.properties).every((p) => typeof p.type === "string");
  const fields: Field[] = Object.entries(schema?.properties ?? {}).map(
    ([name, p]) =>
      ({
        ...p,
        name,
        title: typeof p.title === "string" ? p.title : name,
        required: schema?.required?.includes(name) ?? false,
        type: p.type === "boolean" ? undefined : p.type,
      }) as Field,
  );
  supported &&= fields.length <= 64 && fields.every(supportedField);
  return { ...raw, fields, supported: !!supported };
}
function supportedField(f: Field) {
  return (
    (f.type === undefined ||
      ["boolean", "string", "integer", "number"].includes(f.type) ||
      (f.type === "array" && f.items?.type === "string" && !!f.items.enum)) &&
    (!f.enum || f.enum.every((x) => typeof x === "string"))
  );
}
export function validateAnswer(
  q: Question,
  values: Record<string, unknown>,
  now = Date.now(),
): Record<string, string | number | boolean | string[]> {
  if (!q.supported)
    throw new Error("This question uses fields this version cannot answer.");
  if (now >= q.expiresAtMs)
    throw new Error(
      "This question expired. Refresh to read the current question.",
    );
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const f of q.fields) {
    const value = values[f.name];
    if (value === undefined || value === "") {
      if (f.required) throw new Error(`${f.title} is required.`);
      continue;
    }
    if (f.type === "number" || f.type === "integer") {
      const n = typeof value === "number" ? value : Number(value);
      if (
        !Number.isFinite(n) ||
        (f.type === "integer" && !Number.isInteger(n)) ||
        (f.minimum !== undefined && n < f.minimum) ||
        (f.maximum !== undefined && n > f.maximum)
      )
        throw new Error(`${f.title} is outside the allowed range.`);
      out[f.name] = n;
    } else if (!f.type || f.type === "boolean") {
      if (typeof value !== "boolean")
        throw new Error(`${f.title} needs a yes or no answer.`);
      out[f.name] = value;
    } else if (f.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        value.some((v) => typeof v !== "string" || !f.items?.enum?.includes(v))
      )
        throw new Error(`Choose valid values for ${f.title}.`);
      out[f.name] = value;
    } else {
      if (
        typeof value !== "string" ||
        value.length > (f.maxLength ?? 4096) ||
        value.length < (f.minLength ?? 0) ||
        (f.enum && !f.enum.includes(value))
      )
        throw new Error(`Check ${f.title}.`);
      if (f.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        throw new Error("Enter an email address.");
      if (f.format === "uri") {
        try {
          new URL(value);
        } catch {
          throw new Error("Enter a complete URL.");
        }
      }
      out[f.name] = value;
    }
  }
  return out;
}
export const words = (p: Project) =>
  p.status?.text ??
  p.progress ??
  {
    new: "Draft",
    ready: "Ready to print",
    "touching-up": "Working",
    printing: "Printing",
    printed: "Printed",
    confirmed: "Done",
    "needs-closeup": "Needs you",
    failed: "Needs attention",
    sent: "Sent to printer",
  }[p.state] ??
  p.state;
export const activePrint = (p: Project) =>
  p.state === "printing" || !!p.print?.uncertain;
export const duration = (seconds?: number) =>
  seconds === undefined
    ? "Time unavailable"
    : seconds < 3600
      ? `${Math.ceil(seconds / 60)} min`
      : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
export function newerProject(existing: Project | undefined, incoming: Project) {
  return existing && existing.updatedAtMs > incoming.updatedAtMs
    ? existing
    : incoming;
}
