# Counterpart events

Every user-visible change on the Mac becomes one event: a pass starting, a question, a print starting, progress, the end of a print. The companion writes events; the Mac app turns them into Mac notifications, CloudKit records and Live Activity pushes (PRD §8.8); the phone reads them on the LAN for its own UI. All notification wording comes from one place, `services/companion/src/events/words.ts`, so every surface says the same thing.

Status: the event type and its words are fixed by this document. The print events are produced from KAN-214 PR 2, and the log, `GET /v1/events`, the frame route and `events.wait` arrive in PR 3. The pass events are produced from PR 4.

Schema: `CounterpartEventSchema` in `packages/contracts/src/counterpart.ts`. One sample of every type: `packages/contracts/fixtures/counterpart-v1.json` (`events`).

## The event

```ts
type CounterpartEvent = {
  v: 1; seq: number; id: string /* uuid */; at: string /* ISO */;
  type: "pass.started"|"pass.stage"|"pass.ready"|"pass.ask"|"pass.failed"
      | "print.preparing"|"plate.blocked"|"print.confirm"|"print.started"|"print.status"|"print.first-layer"
      | "print.milestone"|"print.paused"|"print.resumed"|"print.done"|"print.failed"|"print.cancelled"
      | "print.not-started"|"print.unreachable"|"print.sent"
      | "mcp.update.started"|"mcp.update.waiting"|"mcp.update.done"|"mcp.update.failed"; // PR 6
  projectId?: string; // absent for an event about the Mac (mcp.update.*), PR 6
  printId?: string; destinationId?: string; printerName?: string;
  title: string; body: string;
  notify: "none"|"passive"|"active"|"timeSensitive";
  data?: { progress?: number; remainingSec?: number; endsAt?: string; layer?: number; totalLayers?: number;
           state?: string; stage?: string; problems?: {code: string; message: string}[];
           estimateSec?: number; grams?: number; askId?: string; confirmationId?: string; expiresAt?: string;
           mcpId?: string; fromVersion?: string; toVersion?: string; log?: string /* ≤ 4 KB, mcp.update.failed */ };
  frame?: string; // path relative to the project directory
};
```

- `seq` is a positive integer, strictly increasing across the companion's whole log, and never reused (it survives pruning and restarts).
- `id` is unique; use it to de-duplicate (for example, a banner the phone already showed from the long poll, PRD §9.2).
- `title` and `body` are complete, ready to show. `title` ≤ 200 characters and `body` ≤ 500; the Live Activity relay's own limits (title 80, alert 200) are the Mac's to apply.
- `frame`, when present, is `prints/<printId>/frames/<eventId>.jpg` under the project's folder. The Mac app reads it from disk (`objects.get` gives the folder as `directory`); the phone fetches `GET /v1/objects/<projectId>/prints/<printId>/frames/<eventId>.jpg`. A frame is a JPEG of at most a few hundred kB. An event never waits more than 10 s for its frame; when the camera is slow or busy the event has no `frame`.
- `printerName` is the destination's display name at the time.
- `data.endsAt` is the printer's report time plus the time it reports left.

## Types, words and levels

*Title* is the project's generated title (PR 4), else the first words of its request, else "Your scan" or "Your project". *Printer* is the destination name. *remaining* is "1 h 5 min", "25 min" or "under a minute". Parts in brackets are left out when their value isn't known.

| `type` | When | `title` | `body` | `notify` | `frame` |
|---|---|---|---|---|---|
| `pass.started` | A pass starts (new project, Ask for changes, a late photo, an Ask answered) | "Your Mac is working on *Title*" | "About *N* min. You can put your phone down." / without an estimate "You can put your phone down. We'll let you know when it's ready." | none | |
| `pass.stage` | The pass moves to its next stage | *Title* | "*stage words* · about *N* min" | none | |
| `pass.ready` | A pass ends with a model | "*Title* is ready to print" | "*W* × *D* × *H* mm" / "Ready to print" | active | |
| `pass.ask` | A pass ends needing a close-up | "*Title*: *question*" | "Take a photo, choose one, or let your Mac make its best guess." | active | |
| `pass.failed` | A pass ends without a model | "*Title* didn't finish" | what happened and what to do | active | |
| `print.preparing` | Print was tapped; each preparation step | "Getting *Title* ready" | the step: "Slicing the model", "Checking the printer", … | none | |
| `plate.blocked` | **Not emitted.** Kept in the type from PRD §8.7; plate alerts were removed with ac44431 and would return only in a later change. | "Something's on the *Printer* plate" | "Looks like there's *item* on your plate. Can you take it off first?" | timeSensitive | |
| `print.confirm` | The printer MCP asks its own confirmation | "*Printer* needs a yes before printing *Title*" | "Open Counterpart to answer." | timeSensitive | |
| `print.started` | The printer reports our job preparing or printing | "Printing *Title* on *Printer*" | the printer's stage ("Heating the bed", "Auto bed leveling") or "Started" | passive | |
| `print.status` | Something changed (below) | *Title* | "[*p*%] [· *remaining* left] [· layer *l* of *L*]" | none | |
| `print.first-layer` | Layer ≥ 2 for the first time (5 % when layers aren't reported) | "*Title*: first layer's down" | "[*remaining* left on ]*Printer*" | passive | yes |
| `print.milestone` | Progress crosses a chosen milestone | 50: "*Title* is halfway"; 25: "*Title* is a quarter done"; 75: "*Title* is three-quarters done"; other: "*Title* is *p*% done" | "[*remaining* left · ][layer *l* of *L* · ]*Printer*" | active | yes |
| `print.paused` | The printer's state becomes paused | "*Printer* paused *Title*" | the first problem's message, else "Open Counterpart to resume." | timeSensitive | yes |
| `print.resumed` | paused → printing | *Title* | "Printing again on *Printer*" | none | |
| `print.done` | The printer finishes our job | "*Title* is done" | "Take it off the plate." | active | yes |
| `print.failed` | The printer reports our job failed | "*Printer* stopped *Title*" | the first problem's message, else "Check the printer, then try again." | timeSensitive | yes |
| `print.cancelled` | Our job was cancelled (from the app or the printer) | "*Title* was cancelled" | "Nothing more will print." | passive | |
| `print.not-started` | Our job didn't appear within 180 s of dispatch | "*Printer* didn't start *Title*" | "Nothing was sent twice. Check the printer, then press Print again." | timeSensitive | |
| `print.unreachable` | 3 failed reads in a row, or offline for ≥ 60 s | "Lost contact with *Printer*" | "Still trying." | passive | |
| `print.sent` | The printer has the print but Counterpart can't follow it (objects-api.md, `sent`) | "Sent *Title* to *Printer*" | "Counterpart can't follow this print." / Bambu Connect: "Finish on your Mac: press Print in Bambu Connect." | passive | |
| `mcp.update.started` | Update began running for an MCP install (PR 6) | "Updating *package*" | "*from* to *to*" | none | |
| `mcp.update.waiting` | Update is waiting for a print on that printer to end | "*package* updates after the current print" | "*from* to *to*" | none | |
| `mcp.update.done` | The new version is installed and its sessions reopened | "Updated *package* to *version*" | "Your printers use it now." | passive | |
| `mcp.update.failed` | Update failed; the old version stays in use | "Couldn't update *package*" | "*from* is still in use. Try again, or install a fresh copy." | active | |

`notify` is the default level from PRD §9.1. The Mac app applies its own Settings → Notifications switches on top; progress events are off by default on the Mac.

**Events about the Mac (PR 6).** `mcp.update.*` have no `projectId`: they are about an MCP install, named by `data.mcpId` (objects-api.md, "Updating the printer MCPs"). They carry `fromVersion` and `toVersion` when known, and `mcp.update.failed` carries `log`, the last 4 KB of what the update printed. Both apps decode events without `projectId` from #210 and #211. The companion emits them by default; `SCAN_TO_MAKE_PROJECTLESS_EVENTS=0` in its environment turns them off (for a client that can't decode them), and the update then reports only through its method's reply. The project fixtures stay in `events`; these samples are in `macEvents` (`packages/contracts/fixtures/counterpart-v1.json`).

`data` per type: print events carry `state`, `progress`, `remainingSec`, `endsAt`, `layer`, `totalLayers` and `stage` whenever the printer reported them, and `problems` when there are any. `print.started` also carries the slice `estimateSec` and `grams`. `pass.started` and `pass.stage` carry `stage` (the stage's words) and `estimateSec` (the pass's time left). `pass.ask` carries `askId`. `print.confirm` carries `confirmationId` and `expiresAt`.

## The print monitor

One monitor runs per dispatched print and holds its printer's MCP session until the print ends (PRD §8.6).

- **Our job.** bambu-printer-mcp: the report's job id equals the `taskId` `print_3mf` returned (H2 and P2S); a missing, empty or `"0"` id is not a key, and the job name is compared with `subtaskName` (or BambuNetwork's `printerJobName`, or the uploaded file's name without `.3mf`) instead. mcp-3D-printer-server: the job name equals the uploaded file name. A different job running is `replaced`. With no identity at all, a job named after the sliced file is adopted within the start window, and nothing else counts as ours or as replacing it; without one the print ends `sent`.
- **Phase 1.** Read every 3 s for up to 180 s. The first report of our job preparing or printing emits `print.started`. None: `print.not-started`.
- **Phase 2.** Read every 10 s. `print.status` is emitted when progress moves by ≥ 1 point, the state, layer or problems change, or 60 s have passed since the last one.
- **Older MCP installs.** Without `counterpart_print_progress` the monitor reads `get_printer_status`. On bambu-printer-mcp each of those reads makes the printer send its whole report (`push_all`), which OpenBambuAPI advises against doing often on P1-series printers, so this fallback reads every 10 s in phase 1 and every 30 s in phase 2. mcp-3D-printer-server's `get_printer_status` has no job progress: the monitor reports only the state, and the printer's capabilities say "Update mcp-3D-printer-server to see progress".
- **Unreachable.** After 3 failed reads in a row, or 60 s of `offline`, `print.unreachable` is emitted once and reads continue every 30 s. The first good read returns to the normal rate and emits `print.status`.
- **Milestones.** From the companion setting `milestones` (`off`, `50` (default), `25-50-75`, `every-10`). Each is sent once per print (`print.monitor.milestonesSent`).
- **Restarts.** The monitor's state is saved in the project (`print.monitor`). After a restart, monitors in `starting` or `watching` resume. A milestone already passed while the Mac was asleep or the companion was down is recorded as sent without an event (no back-fill); `first-layer` likewise. The end of the print is always delivered.

## Reading events

### Phone: `GET /v1/events` (READ scope)

`GET /v1/events?after=<seq>&wait=<seconds>&limit=<n>` → `EventsPage`:

```json
{"events": [/* CounterpartEvent, seq ascending */], "next": 19, "latest": 19}
```

- `after` (default 0): return events with `seq > after`. `wait` (0–25, default 0): when there are none yet, hold the request up to that many seconds and return as soon as one arrives (a long poll). `limit` (0–500, default 100): the page size. A full page returns at once.
- `next`: send it as `after` next time. It is the last returned `seq`, or `after` when nothing was returned.
- `latest`: the newest `seq` in the log. To start from now without reading history, send `limit=0`: the reply is `{events: [], next: latest, latest}`.
- `truncated: true`: `after` is older than the oldest retained event (events are kept 7 days); the page starts at the oldest retained one. Reload the objects list, then carry on from `next`.
- `reset: true`: `after` is beyond `latest` (the log was recreated). The reply has no events and `next` is `latest`. Reload the objects list, then carry on from `next`.
- The companion re-checks the pairing before it answers a held request, ends the wait when the phone disconnects, and holds at most 32 long polls at a time (beyond that: 503 `busy`, retry after a second).

### Mac: control method `events.wait`

`{after: number, timeoutMs?: number ≤ 25000, limit?: number ≤ 500}` → the same `EventsPage`. It is exempt from the socket's usual 10 s connection deadline: the connection stays open up to `timeoutMs` plus 5 s. Frames are read from disk at `<directory>/<frame>`.

### Storage

`<data root>/events.ndjson`: one JSON event per line, appended; the data root is the parent of the auth directory (`~/Library/Application Support/Scan to Make/` for the app). Mode 0600. Events older than 7 days are dropped at start and every hour; the highest `seq` is kept in `events.meta.json` so numbering continues after pruning. Clients never read these files directly.
