import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { APNS_TOPIC, apnsBody, apnsPush, importApnsKey, pkcs8FromPem, readApnsResponse, signProviderToken } from "../src/apns";
import { validateRelayRequest, type RelayRequest } from "../src/contract";
import { NOW_SEC, apnsError, decodeJwt, endRequest, referenceSeconds, startRequest, updateRequest } from "./helpers";

function valid(body: unknown): RelayRequest {
  const result = validateRelayRequest(body, NOW_SEC);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.value;
}

describe("provider token (ES256 JWT)", () => {
  it("has Apple's header and claims and verifies against the key's public half", async () => {
    const key = await importApnsKey(env.APNS_KEY_P8!);
    const jwt = await signProviderToken(key, "ABC123DEFG", "X7F5F9LR24", NOW_SEC);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decoded = await decodeJwt(jwt, env.TEST_APNS_PUBLIC_KEY);
    expect(decoded.header).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decoded.claims).toEqual({ iss: "X7F5F9LR24", iat: NOW_SEC });
    // JWS ES256 is the raw 64-byte r‖s signature, not DER.
    expect(decoded.signatureBytes).toBe(64);
    expect(decoded.verified).toBe(true);
  });

  it("reads the .p8 as a file, as a one-line paste with \\n escapes, and as bare base64", async () => {
    const pem = env.APNS_KEY_P8!;
    const der = pkcs8FromPem(pem);
    expect(pkcs8FromPem(pem.replace(/\n/g, "\\n"))).toEqual(der);
    expect(pkcs8FromPem(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""))).toEqual(der);
    await expect(importApnsKey("not a key")).rejects.toThrow();
  });
});

describe("APNs request", () => {
  it("sends a start with the PRD's headers and body, plus input-push-token", () => {
    const body = startRequest();
    const push = apnsPush("https://api.push.apple.com", valid(body), "JWT", NOW_SEC);
    expect(push.url).toBe(`https://api.push.apple.com/3/device/${body.token}`);
    expect(push.headers).toEqual({
      authorization: "bearer JWT",
      "apns-push-type": "liveactivity",
      "apns-topic": "com.scantomake.push-type.liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    expect(JSON.parse(push.body)).toStrictEqual({
      aps: {
        timestamp: NOW_SEC,
        event: "start",
        "content-state": {
          state: "preparing",
          progress: 0,
          layer: 0,
          totalLayers: 300,
          endsAt: referenceSeconds(NOW_SEC + 3600),
          stage: "Heating the bed",
        },
        "stale-date": NOW_SEC + 4200,
        "attributes-type": "PrintAttributes",
        attributes: {
          projectId: body.attributes.projectId,
          printId: body.attributes.printId,
          title: "Desk hook",
          printerName: "Bambu Lab P1S",
        },
        "input-push-token": 1,
        alert: { title: "Desk hook is printing", body: "On Bambu Lab P1S" },
      },
    });
    // The serialized key order follows PRD §8.8.
    expect(Object.keys((JSON.parse(push.body) as { aps: object }).aps)).toEqual([
      "timestamp",
      "event",
      "content-state",
      "stale-date",
      "attributes-type",
      "attributes",
      "input-push-token",
      "alert",
    ]);
  });

  it("sends a progress update at priority 5 with no attributes, alert or dismissal date", () => {
    const body = updateRequest();
    const push = apnsPush("https://api.push.apple.com", valid(body), "JWT", NOW_SEC);
    expect(push.headers["apns-priority"]).toBe("5");
    expect(push.headers["apns-topic"]).toBe(APNS_TOPIC);
    expect(JSON.parse(push.body)).toStrictEqual({
      aps: {
        timestamp: NOW_SEC,
        event: "update",
        "content-state": {
          state: "printing",
          progress: 42.5,
          layer: 120,
          totalLayers: 300,
          endsAt: referenceSeconds(NOW_SEC + 3600),
          stage: "Printing",
        },
        "stale-date": NOW_SEC + 4200,
      },
    });
  });

  it("sends a paused update with its problem and alert", () => {
    const base = updateRequest();
    const body = {
      ...base,
      priority: 10,
      contentState: { ...base.contentState, state: "paused", problem: "AMS slot 1 ran out of filament" },
      alert: { title: "Bambu Lab P1S paused Desk hook", body: "AMS slot 1 ran out of filament" },
    };
    const aps = (apnsBody(valid(body), NOW_SEC) as { aps: Record<string, unknown> }).aps;
    expect(aps["content-state"]).toStrictEqual({ ...base.contentState, state: "paused", problem: "AMS slot 1 ran out of filament" });
    expect(aps.alert).toStrictEqual({ title: "Bambu Lab P1S paused Desk hook", body: "AMS slot 1 ran out of filament" });
    expect(aps).not.toHaveProperty("dismissal-date");
  });

  it("sends an end with a dismissal date 4 hours later and no stale date unless given", () => {
    const body = endRequest();
    expect(apnsBody(valid(body), NOW_SEC)).toStrictEqual({
      aps: {
        timestamp: NOW_SEC,
        event: "end",
        "content-state": {
          state: "finished",
          progress: 100,
          layer: 300,
          totalLayers: 300,
          endsAt: referenceSeconds(NOW_SEC),
          stage: "",
        },
        alert: { title: "Desk hook is done", body: "Take it off the plate.", sound: "default" },
        "dismissal-date": NOW_SEC + 4 * 3600,
      },
    });
    const withStale = (apnsBody(valid({ ...body, staleDate: NOW_SEC + 60 }), NOW_SEC) as { aps: Record<string, unknown> }).aps;
    expect(withStale["stale-date"]).toBe(NOW_SEC + 60);
  });
});

describe("APNs answers", () => {
  const cases: [Response, string][] = [
    [new Response(null, { status: 200, headers: { "apns-id": "abc" } }), "delivered"],
    [apnsError(410, "Unregistered"), "token-dead"],
    [apnsError(410, "ExpiredToken"), "token-dead"],
    [apnsError(400, "BadDeviceToken"), "token-dead"],
    [apnsError(400, "DeviceTokenNotForTopic"), "rejected"],
    [apnsError(400, "BadTopic"), "rejected"],
    [apnsError(403, "ExpiredProviderToken"), "provider-token"],
    [apnsError(403, "InvalidProviderToken"), "provider-token"],
    [apnsError(403, "BadEnvironmentKeyIdInToken"), "rejected"],
    [apnsError(413, "PayloadTooLarge"), "rejected"],
    [apnsError(429, "TooManyRequests"), "retry"],
    [apnsError(500, "InternalServerError"), "retry"],
    [new Response("<html>", { status: 503 }), "retry"],
  ];
  for (const [response, kind] of cases) {
    it(`reads ${response.status} as ${kind}`, async () => {
      expect((await readApnsResponse(response)).kind).toBe(kind);
    });
  }
});
