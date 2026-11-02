import { describe, expect, it } from "vitest";
import { validateRelayRequest } from "../src/contract";
import { NOW_SEC, endRequest, startRequest, updateRequest } from "./helpers";

function problems(body: unknown): string[] {
  const result = validateRelayRequest(body, NOW_SEC);
  if (result.ok) throw new Error("expected the request to be rejected");
  return result.problems;
}

function accepts(body: unknown) {
  const result = validateRelayRequest(body, NOW_SEC);
  if (!result.ok) throw new Error(`expected the request to pass: ${result.problems.join("; ")}`);
  return result.value;
}

describe("accepted requests", () => {
  it("accepts a start, an update and an end", () => {
    expect(accepts(startRequest()).kind).toBe("start");
    expect(accepts(updateRequest()).kind).toBe("update");
    expect(accepts(endRequest()).kind).toBe("end");
  });

  it("lowercases the token and keeps an optional problem", () => {
    const body = updateRequest();
    body.token = body.token.toUpperCase();
    const value = accepts({ ...body, contentState: { ...body.contentState, state: "paused", problem: "AMS slot 1 ran out of filament" } });
    expect(value.token).toBe(body.token.toLowerCase());
    expect(value.contentState.problem).toBe("AMS slot 1 ran out of filament");
  });

  it("counts characters as Unicode scalars, so an 80-emoji title fits", () => {
    const body = startRequest();
    body.attributes.title = "🖨".repeat(80);
    expect(accepts(body).attributes?.title).toHaveLength(160);
  });

  it("accepts 0 and an empty stage for printers that don't report layers or stages", () => {
    const body = updateRequest();
    expect(accepts({ ...body, contentState: { ...body.contentState, layer: 0, totalLayers: 0, stage: "" } }).contentState.totalLayers).toBe(0);
  });
});

describe("rejected requests", () => {
  const cases: [string, () => unknown, string][] = [
    ["a non-object body", () => [updateRequest()], "$: must be a JSON object"],
    ["null", () => null, "$: must be a JSON object"],
    ["an unknown top-level key", () => ({ ...updateRequest(), topic: "com.other.app" }), "topic: is not allowed"],
    ["an unknown content-state key", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, url: "x" } }; }, "contentState.url: is not allowed"],
    ["an unknown attributes key", () => { const b = startRequest(); return { ...b, attributes: { ...b.attributes, extra: 1 } }; }, "attributes.extra: is not allowed"],
    ["an unknown alert key", () => { const b = startRequest(); return { ...b, alert: { ...b.alert, "loc-key": "x" } }; }, "alert.loc-key: is not allowed"],
    ["a missing token", () => { const { token: _, ...b } = updateRequest(); return b; }, "token: is required"],
    ["a non-hex token", () => ({ ...updateRequest(), token: "z".repeat(64) }), "token: must be the push token as an even-length hex string"],
    ["an odd-length token", () => ({ ...updateRequest(), token: "a".repeat(63) }), "token: must be the push token as an even-length hex string"],
    ["a token with a path in it", () => ({ ...updateRequest(), token: "../../3/device/abcd" }), "token: must be the push token as an even-length hex string"],
    ["a too-short token", () => ({ ...updateRequest(), token: "ab".repeat(8) }), "token: must be 32–512 hex digits"],
    ["a too-long token", () => ({ ...updateRequest(), token: "ab".repeat(257) }), "token: must be 32–512 hex digits"],
    ["another kind", () => ({ ...updateRequest(), kind: "alert" }), 'kind: must be one of "start", "update", "end"'],
    ["another priority", () => ({ ...updateRequest(), priority: 1 }), "priority: must be one of 5, 10"],
    ["a string priority", () => ({ ...updateRequest(), priority: "10" }), "priority: must be one of 5, 10"],
    ["a title over 80 characters", () => { const b = startRequest(); b.attributes.title = "x".repeat(81); return b; }, "attributes.title: must be 1–80 characters"],
    ["an empty title", () => { const b = startRequest(); b.attributes.title = ""; return b; }, "attributes.title: must be 1–80 characters"],
    ["a printer name over 80 characters", () => { const b = startRequest(); b.attributes.printerName = "p".repeat(81); return b; }, "attributes.printerName: must be 1–80 characters"],
    ["a project id with a slash", () => { const b = startRequest(); b.attributes.projectId = "a/b"; return b; }, "attributes.projectId: may only contain letters, digits, '.', '_', ':' and '-'"],
    ["an alert over 200 characters", () => ({ ...updateRequest(), alert: { title: "t".repeat(100), body: "b".repeat(101) } }), "alert: title and body together must be at most 200 characters"],
    ["an alert body alone over 200 characters", () => ({ ...updateRequest(), alert: { title: "t", body: "b".repeat(201) } }), "alert.body: must be 0–200 characters"],
    ["a custom alert sound", () => ({ ...updateRequest(), alert: { title: "t", body: "b", sound: "chime.aiff" } }), 'alert.sound: must be one of "default"'],
    ["a localized alert", () => ({ ...updateRequest(), alert: { title: { "loc-key": "x" }, body: "b" } }), "alert.title: must be a string"],
    ["attributes on an update", () => ({ ...updateRequest(), attributes: startRequest().attributes }), 'attributes: is only allowed when kind is "start"'],
    ["attributes on an end", () => ({ ...endRequest(), attributes: startRequest().attributes }), 'attributes: is only allowed when kind is "start"'],
    ["a start without attributes", () => { const { attributes: _, ...b } = startRequest(); return b; }, 'attributes: is required when kind is "start"'],
    ["a start without an alert", () => { const { alert: _, ...b } = startRequest(); return b; }, 'alert: is required when kind is "start" (Apple requires an alert to start a Live Activity)'],
    ["an update without a stale date", () => { const { staleDate: _, ...b } = updateRequest(); return b; }, 'staleDate: is required when kind is "update"'],
    ["a state outside counterpart/1", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, state: "done" } }; }, "contentState.state: must be one of"],
    ["progress over 100", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, progress: 101 } }; }, "contentState.progress: must be between 0 and 100"],
    ["progress as a fraction string", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, progress: "0.5" } }; }, "contentState.progress: must be a number"],
    ["a negative layer", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, layer: -1 } }; }, "contentState.layer: must be between 0 and 10000000"],
    ["a fractional layer count", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, totalLayers: 2.5 } }; }, "contentState.totalLayers: must be an integer"],
    ["a null layer", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, layer: null } }; }, "contentState.layer: must be an integer"],
    ["a missing stage", () => { const b = updateRequest(); const { stage: _, ...cs } = b.contentState; return { ...b, contentState: cs }; }, "contentState.stage: is required"],
    ["an empty problem", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, problem: "" } }; }, "contentState.problem: must be 1–200 characters"],
    ["endsAt in Unix seconds", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, endsAt: NOW_SEC + 3600 } }; }, "contentState.endsAt: looks like Unix seconds; send seconds since 2001-01-01 (Swift's default Date encoding)"],
    ["endsAt as an ISO string", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, endsAt: "2026-11-01T13:00:00Z" } }; }, "contentState.endsAt: must be a number (seconds since 2001-01-01)"],
    ["endsAt in milliseconds", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, endsAt: (NOW_SEC + 3600) * 1000 } }; }, "contentState.endsAt: must be seconds since 2001-01-01 within 1 day before and 30 days after now"],
    ["staleDate in reference-date seconds", () => ({ ...updateRequest(), staleDate: NOW_SEC + 4200 - 978_307_200 }), "staleDate: looks like seconds since 2001-01-01; send Unix seconds (seconds since 1970-01-01)"],
    ["staleDate in milliseconds", () => ({ ...updateRequest(), staleDate: (NOW_SEC + 4200) * 1000 }), "staleDate: must be Unix seconds within 1 day before and 30 days after now"],
    ["a fractional staleDate", () => ({ ...updateRequest(), staleDate: NOW_SEC + 0.5 }), "staleDate: must be an integer (Unix seconds)"],
    ["a control character in the title", () => { const b = startRequest(); b.attributes.title = "Desk\nhook"; return b; }, "attributes.title: must not contain control characters"],
    ["a lone surrogate in the stage", () => { const b = updateRequest(); return { ...b, contentState: { ...b.contentState, stage: "\ud800x" } }; }, "contentState.stage: must be valid Unicode"],
  ];

  for (const [name, body, expected] of cases) {
    it(`rejects ${name}`, () => {
      const found = problems(body());
      expect(found.some((p) => p.startsWith(expected)), `${expected}\nnot in\n${found.join("\n")}`).toBe(true);
    });
  }

  it("reports every problem at once", () => {
    const body = { ...updateRequest(), priority: 7, kind: "update", token: "x" };
    expect(problems(body)).toHaveLength(2);
  });
});
