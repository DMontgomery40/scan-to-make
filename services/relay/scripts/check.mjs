#!/usr/bin/env node
// After a deploy: sends one well-formed update for a random token, which no phone has, and reads
// the answer. APNs can only call that token unknown after it has accepted the relay's provider
// token over HTTP/2, so a BadDeviceToken answer proves the secrets, the JWT and the APNs path.
//
//   npm run check                  # https://counterpart.dtmont.com/relay/v1/live-activity
//   npm run check -- <relay URL>   # another deployment, or wrangler dev

import { randomBytes } from "node:crypto";

const url = process.argv[2] ?? "https://counterpart.dtmont.com/relay/v1/live-activity";
const nowSec = Math.floor(Date.now() / 1000);
const body = {
  token: randomBytes(32).toString("hex"),
  kind: "update",
  contentState: { state: "printing", progress: 1, layer: 0, totalLayers: 0, endsAt: nowSec + 3600 - 978_307_200, stage: "" },
  staleDate: nowSec + 4200,
  priority: 5,
};

const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = await response.text();
let answer = {};
try {
  answer = JSON.parse(text);
} catch {
  // not the relay
}

const verdicts = [
  [response.status === 410 && answer.reason === "BadDeviceToken", true, "Working: APNs accepted the relay's key and called the made-up token unknown."],
  [response.status === 503 && answer.error === "not_configured", false, "A secret is missing or malformed: APNS_KEY_P8, APNS_KEY_ID (10 characters) or TEAM_ID (X7F5F9LR24)."],
  [response.status === 503 && answer.error === "apns_auth", false, "APNs refused the provider token: check APNS_KEY_ID, TEAM_ID and that APNS_KEY_P8 is that key's .p8."],
  [response.status === 502 && answer.reason === "BadEnvironmentKeyIdInToken", false, "The key is Sandbox-only: create a Production APNs key."],
  [response.status === 503 && answer.error === "apns_unreachable", false, "The Worker couldn't reach api.push.apple.com (the HTTP/2 path). See README, \"HTTP/2 to APNs\"."],
  [response.status === 429, false, `Rate limited (${answer.scope}); try again in ${response.headers.get("retry-after")} s.`],
];
const [, ok, message] = verdicts.find(([matches]) => matches) ?? [true, false, "Unexpected answer; see `npx wrangler tail counterpart-relay`."];
console.log(`${response.status} ${text}`);
console.log(message);
process.exit(ok ? 0 : 1);
