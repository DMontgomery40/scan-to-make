#!/usr/bin/env node
// Local smoke test: runs the Worker under `wrangler dev` against a loopback stand-in for APNs,
// with a throwaway P-256 key, and sends real HTTP requests to it. Nothing leaves this machine.
// Local workerd has no outbound HTTP/2, so it can't reach api.push.apple.com; production can.
//
//   npm run smoke

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "relay-smoke-"));
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const apnsCalls = [];
// Like APNs: it knows one device token and calls every other one BadDeviceToken.
const knownToken = randomBytes(32).toString("hex");
const apns = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    apnsCalls.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (req.url === `/3/device/${knownToken}`) res.writeHead(200, { "apns-id": "00000000-0000-4000-8000-000000000001" }).end();
    else res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ reason: "BadDeviceToken" }));
  });
});
await new Promise((resolve) => apns.listen(0, "127.0.0.1", resolve));
const apnsPort = apns.address().port;

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const envFile = join(work, "smoke.env");
await writeFile(
  envFile,
  [
    `APNS_KEY_P8="${pem.trim().replace(/\n/g, "\\n")}"`,
    "APNS_KEY_ID=SMOKETEST1",
    "TEAM_ID=X7F5F9LR24",
    `APNS_ORIGIN=http://127.0.0.1:${apnsPort}`,
  ].join("\n"),
);

const port = 20_000 + Math.floor(Math.random() * 20_000);
// Its own process group, so stopping it also stops the workerd processes it starts.
const wrangler = spawn(
  process.execPath,
  [join(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--ip", "127.0.0.1", "--port", String(port), "--env-file", envFile, "--persist-to", join(work, "state"), "--show-interactive-dev-session=false"],
  { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
const stopWrangler = async () => {
  if (wrangler.exitCode !== null || wrangler.signalCode !== null) return;
  const exited = new Promise((resolve) => wrangler.once("exit", resolve));
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-wrangler.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await exited;
  clearTimeout(timer);
  wrangler.stdout.destroy();
  wrangler.stderr.destroy();
};
// Never hang a CI job: give up after two minutes.
setTimeout(() => {
  console.error(`smoke timed out\n${output}`);
  try {
    process.kill(-wrangler.pid, "SIGKILL");
  } catch {
    // already gone
  }
  process.exit(1);
}, 120_000).unref();
let output = "";
wrangler.stdout.on("data", (d) => (output += d));
wrangler.stderr.on("data", (d) => (output += d));

const url = `http://127.0.0.1:${port}/relay/v1/live-activity`;
const post = (body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).status === 405) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev didn't start:\n${output}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ref = (unix) => unix - 978_307_200;
  const token = knownToken;
  const start = {
    token,
    kind: "start",
    attributes: { projectId: "2f1d7c9e-1b7a-4c1e-9a55-7d0f0c3e8b21", printId: "9b0e4a6c-3c51-4e0b-8f3a-1c2d3e4f5a6b", title: "Desk hook", printerName: "Bambu Lab P1S" },
    contentState: { state: "preparing", progress: 0, layer: 0, totalLayers: 300, endsAt: ref(nowSec + 3600), stage: "Heating the bed" },
    staleDate: nowSec + 4200,
    priority: 10,
    alert: { title: "Desk hook is printing", body: "On Bambu Lab P1S" },
  };

  const first = await post(start);
  const firstBody = await first.json();
  check(first.status === 200 && firstBody.ok === true, `start → ${first.status} ${JSON.stringify(firstBody)}`);
  const call = apnsCalls[0];
  check(call?.url === `/3/device/${token}`, `APNs path /3/device/<token>`);
  check(call?.headers["apns-push-type"] === "liveactivity" && call?.headers["apns-topic"] === "com.scantomake.push-type.liveactivity" && call?.headers["apns-priority"] === "10", "APNs headers");
  check(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(call?.headers.authorization ?? ""), "APNs bearer JWT");
  check(call?.body?.aps?.event === "start" && call?.body?.aps?.["attributes-type"] === "PrintAttributes" && call?.body?.aps?.["input-push-token"] === 1, "APNs start body");

  const again = await post({ ...start, kind: "update", attributes: undefined, alert: undefined, priority: 5 });
  check(again.status === 429 && Number(again.headers.get("retry-after")) <= 10, `update inside 10 s → ${again.status}, Retry-After ${again.headers.get("retry-after")}`);

  const invalid = await post({ ...start, attributes: { ...start.attributes, title: "x".repeat(81) } });
  check(invalid.status === 400, `81-character title → ${invalid.status} ${JSON.stringify(await invalid.json())}`);
  check(apnsCalls.length === 1, "only the accepted push reached APNs");

  // The README's post-deploy check, against this deployment.
  const checkRun = spawn(process.execPath, [join(root, "scripts/check.mjs"), url], { stdio: ["ignore", "pipe", "pipe"] });
  let checkOutput = "";
  checkRun.stdout.on("data", (d) => (checkOutput += d));
  checkRun.stderr.on("data", (d) => (checkOutput += d));
  const checkExit = await new Promise((resolve) => checkRun.on("close", resolve));
  check(checkExit === 0 && /Working/.test(checkOutput), `npm run check → ${checkOutput.trim().split("\n").pop()}`);
} finally {
  await stopWrangler();
  apns.close();
  await rm(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke ok");
process.exit(0);
