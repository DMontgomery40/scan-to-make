// The request the Mac app's EventRelay sends to POST /relay/v1/live-activity (PRD §8.8, §9.4).
// Validation is strict: every object rejects unknown keys, every string and number is bounded,
// and the result is rebuilt field by field, so nothing the caller sends reaches APNs unchecked.
// docs.md is the human-readable version of this file; keep them in step.

/** `state` values from the counterpart/1 `counterpart_print_progress` result (PRD §8.4). */
export const PRINT_STATES = [
  "idle",
  "preparing",
  "printing",
  "paused",
  "finished",
  "failed",
  "cancelled",
  "offline",
  "busy",
] as const;
export type PrintState = (typeof PRINT_STATES)[number];

export type RelayKind = "start" | "update" | "end";
export type ApnsPriority = 5 | 10;

/** `PrintAttributes` in the iPhone app (static for the activity's life). */
export interface PrintAttributes {
  projectId: string;
  printId: string;
  title: string;
  printerName: string;
}

/** `PrintAttributes.ContentState` in the iPhone app. */
export interface PrintContentState {
  state: PrintState;
  /** 0–100, as in counterpart/1. */
  progress: number;
  /** 0 when the printer doesn't report layers. */
  layer: number;
  /** 0 when the printer doesn't report layers. */
  totalLayers: number;
  /** Seconds since 2001-01-01T00:00:00Z: how Swift's default Codable encodes `Date`. */
  endsAt: number;
  /** Empty when the printer reports no stage. */
  stage: string;
  problem?: string;
}

export interface RelayAlert {
  title: string;
  body: string;
  sound?: "default";
}

export interface RelayRequest {
  token: string;
  kind: RelayKind;
  attributes?: PrintAttributes;
  contentState: PrintContentState;
  /** Unix seconds. */
  staleDate?: number;
  priority: ApnsPriority;
  alert?: RelayAlert;
}

/** Seconds between the Unix epoch and Swift's reference date (2001-01-01T00:00:00Z). */
export const REFERENCE_DATE_OFFSET = 978_307_200;

const DAY = 86_400;

export const BOUNDS = {
  tokenHexMin: 32,
  tokenHexMax: 512,
  idMax: 128,
  titleMax: 80,
  printerNameMax: 80,
  stageMax: 80,
  problemMax: 200,
  /** Alert title and body together. */
  alertMax: 200,
  layerMax: 10_000_000,
  /** Dates may lie this far in the past (a print that overran its estimate)… */
  pastSec: DAY,
  /** …and this far in the future (a multi-day print). */
  futureSec: 30 * DAY,
} as const;

export type Validation = { ok: true; value: RelayRequest } | { ok: false; problems: string[] };

type Json = unknown;
type Obj = Record<string, Json>;

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
// C0 and C1 control characters, which no field needs and which would only render as garbage.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Length in Unicode scalars: Swift's `string.unicodeScalars.count`. */
export function scalarLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

class Checker {
  readonly problems: string[] = [];

  fail(path: string, message: string): undefined {
    this.problems.push(`${path}: ${message}`);
    return undefined;
  }

  object(value: Json, path: string, required: readonly string[], optional: readonly string[]): Obj | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return this.fail(path, "must be a JSON object");
    }
    const obj = value as Obj;
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) this.fail(path === "$" ? key : `${path}.${key}`, "is not allowed");
    }
    for (const key of required) {
      if (!(key in obj)) this.fail(path === "$" ? key : `${path}.${key}`, "is required");
    }
    return obj;
  }

  text(value: Json, path: string, min: number, max: number): string | undefined {
    if (typeof value !== "string") return this.fail(path, "must be a string");
    if (CONTROL.test(value)) return this.fail(path, "must not contain control characters");
    if (LONE_SURROGATE.test(value)) return this.fail(path, "must be valid Unicode");
    const length = scalarLength(value);
    if (length < min || length > max) {
      return this.fail(path, min === max ? `must be ${min} characters` : `must be ${min}–${max} characters`);
    }
    return value;
  }

  id(value: Json, path: string): string | undefined {
    const text = this.text(value, path, 1, BOUNDS.idMax);
    if (text === undefined) return undefined;
    if (!ID_PATTERN.test(text)) return this.fail(path, "may only contain letters, digits, '.', '_', ':' and '-'");
    return text;
  }

  integer(value: Json, path: string, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return this.fail(path, "must be an integer");
    if (value < min || value > max) return this.fail(path, `must be between ${min} and ${max}`);
    return value;
  }

  number(value: Json, path: string, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return this.fail(path, "must be a number");
    if (value < min || value > max) return this.fail(path, `must be between ${min} and ${max}`);
    return value;
  }

  oneOf<T extends string | number>(value: Json, path: string, choices: readonly T[]): T | undefined {
    if (!choices.includes(value as T)) return this.fail(path, `must be one of ${choices.map((c) => JSON.stringify(c)).join(", ")}`);
    return value as T;
  }

  /** Unix seconds, near now. */
  unixDate(value: Json, path: string, nowSec: number): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) return this.fail(path, "must be an integer (Unix seconds)");
    if (value >= nowSec - BOUNDS.pastSec - REFERENCE_DATE_OFFSET && value <= nowSec + BOUNDS.futureSec - REFERENCE_DATE_OFFSET) {
      return this.fail(path, "looks like seconds since 2001-01-01; send Unix seconds (seconds since 1970-01-01)");
    }
    if (value < nowSec - BOUNDS.pastSec || value > nowSec + BOUNDS.futureSec) {
      return this.fail(path, "must be Unix seconds within 1 day before and 30 days after now");
    }
    return value;
  }

  /** Swift reference-date seconds (default `Date` Codable), near now. */
  referenceDate(value: Json, path: string, nowSec: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return this.fail(path, "must be a number (seconds since 2001-01-01)");
    if (value >= nowSec - BOUNDS.pastSec && value <= nowSec + BOUNDS.futureSec) {
      return this.fail(path, "looks like Unix seconds; send seconds since 2001-01-01 (Swift's default Date encoding)");
    }
    const nowRef = nowSec - REFERENCE_DATE_OFFSET;
    if (value < nowRef - BOUNDS.pastSec || value > nowRef + BOUNDS.futureSec) {
      return this.fail(path, "must be seconds since 2001-01-01 within 1 day before and 30 days after now");
    }
    return value;
  }
}

function attributesFrom(check: Checker, value: Json): PrintAttributes | undefined {
  const obj = check.object(value, "attributes", ["projectId", "printId", "title", "printerName"], []);
  if (!obj) return undefined;
  const projectId = check.id(obj.projectId, "attributes.projectId");
  const printId = check.id(obj.printId, "attributes.printId");
  const title = check.text(obj.title, "attributes.title", 1, BOUNDS.titleMax);
  const printerName = check.text(obj.printerName, "attributes.printerName", 1, BOUNDS.printerNameMax);
  if (projectId === undefined || printId === undefined || title === undefined || printerName === undefined) return undefined;
  return { projectId, printId, title, printerName };
}

function contentStateFrom(check: Checker, value: Json, nowSec: number): PrintContentState | undefined {
  const obj = check.object(
    value,
    "contentState",
    ["state", "progress", "layer", "totalLayers", "endsAt", "stage"],
    ["problem"],
  );
  if (!obj) return undefined;
  const state = check.oneOf(obj.state, "contentState.state", PRINT_STATES);
  const progress = check.number(obj.progress, "contentState.progress", 0, 100);
  const layer = check.integer(obj.layer, "contentState.layer", 0, BOUNDS.layerMax);
  const totalLayers = check.integer(obj.totalLayers, "contentState.totalLayers", 0, BOUNDS.layerMax);
  const endsAt = check.referenceDate(obj.endsAt, "contentState.endsAt", nowSec);
  const stage = check.text(obj.stage, "contentState.stage", 0, BOUNDS.stageMax);
  const problem = "problem" in obj ? check.text(obj.problem, "contentState.problem", 1, BOUNDS.problemMax) : undefined;
  if (
    state === undefined ||
    progress === undefined ||
    layer === undefined ||
    totalLayers === undefined ||
    endsAt === undefined ||
    stage === undefined ||
    ("problem" in obj && problem === undefined)
  ) {
    return undefined;
  }
  const result: PrintContentState = { state, progress, layer, totalLayers, endsAt, stage };
  if (problem !== undefined) result.problem = problem;
  return result;
}

function alertFrom(check: Checker, value: Json): RelayAlert | undefined {
  const obj = check.object(value, "alert", ["title", "body"], ["sound"]);
  if (!obj) return undefined;
  const title = check.text(obj.title, "alert.title", 1, BOUNDS.alertMax);
  const body = check.text(obj.body, "alert.body", 0, BOUNDS.alertMax);
  const sound = "sound" in obj ? check.oneOf(obj.sound, "alert.sound", ["default"] as const) : undefined;
  if (title === undefined || body === undefined || ("sound" in obj && sound === undefined)) return undefined;
  if (scalarLength(title) + scalarLength(body) > BOUNDS.alertMax) {
    return check.fail("alert", `title and body together must be at most ${BOUNDS.alertMax} characters`);
  }
  const alert: RelayAlert = { title, body };
  if (sound !== undefined) alert.sound = sound;
  return alert;
}

/** Validates a parsed JSON body. `nowSec` is the current Unix time in seconds. */
export function validateRelayRequest(body: Json, nowSec: number): Validation {
  const check = new Checker();
  const obj = check.object(
    body,
    "$",
    ["token", "kind", "contentState", "priority"],
    ["attributes", "staleDate", "alert"],
  );
  if (!obj) return { ok: false, problems: check.problems };

  let token: string | undefined;
  if (typeof obj.token !== "string" || !HEX_PATTERN.test(obj.token) || obj.token.length % 2 !== 0) {
    check.fail("token", "must be the push token as an even-length hex string");
  } else if (obj.token.length < BOUNDS.tokenHexMin || obj.token.length > BOUNDS.tokenHexMax) {
    check.fail("token", `must be ${BOUNDS.tokenHexMin}–${BOUNDS.tokenHexMax} hex digits`);
  } else {
    token = obj.token.toLowerCase();
  }

  const kind = "kind" in obj ? check.oneOf(obj.kind, "kind", ["start", "update", "end"] as const) : undefined;
  const priority = "priority" in obj ? check.oneOf(obj.priority, "priority", [5, 10] as const) : undefined;
  const contentState = "contentState" in obj ? contentStateFrom(check, obj.contentState, nowSec) : undefined;

  let attributes: PrintAttributes | undefined;
  if (kind === "start") {
    if (!("attributes" in obj)) check.fail("attributes", "is required when kind is \"start\"");
    else attributes = attributesFrom(check, obj.attributes);
  } else if (kind !== undefined && "attributes" in obj) {
    check.fail("attributes", "is only allowed when kind is \"start\"");
  }

  let alert: RelayAlert | undefined;
  if ("alert" in obj) alert = alertFrom(check, obj.alert);
  else if (kind === "start") check.fail("alert", "is required when kind is \"start\" (Apple requires an alert to start a Live Activity)");

  let staleDate: number | undefined;
  if ("staleDate" in obj) staleDate = check.unixDate(obj.staleDate, "staleDate", nowSec);
  else if (kind === "start" || kind === "update") check.fail("staleDate", `is required when kind is "${kind}"`);

  if (check.problems.length > 0 || token === undefined || kind === undefined || priority === undefined || contentState === undefined) {
    return { ok: false, problems: check.problems.length > 0 ? check.problems : ["$: invalid request"] };
  }

  const value: RelayRequest = { token, kind, contentState, priority };
  if (attributes !== undefined) value.attributes = attributes;
  if (staleDate !== undefined) value.staleDate = staleDate;
  if (alert !== undefined) value.alert = alert;
  return { ok: true, value };
}
