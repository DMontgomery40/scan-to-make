# M2a: Mac Object Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The companion keeps a list of objects and runs each one's touch-up through the M1 engine without being asked. It serves the list and each object page to the phone (HTTP) and to the Mac app (control socket), and prints an object's current model with the bed check running in the background.

**Architecture:** a new `services/companion/src/objects/` module:
- `store.ts`: file-based objects;
- `service.ts`: the state machine, plus the touch-up and print orchestration;
- `bedcheck.ts`: plate judging with the user's Claude;
- `http.ts`: phone routes.

Wired into `server.ts`, `server-cli.ts` and the local control socket. It reuses `runTouchup` (M1), `readPrinterHandoffConfig`, `PrinterMcpClient`, the handoff bundle store and runner, and the existing elicitation relay.

**Tech Stack:** TypeScript, `node --test`, the existing companion server and auth.

**Spec:** `docs/superpowers/specs/2026-10-31-app-rebuild-design.md` (§5, §6).

## Global Constraints

- One object = `<captureDir>/objects/<id>/`, containing:
  - `object.json`;
  - `scan/` (the USDZ as sent);
  - `photos/` (as sent);
  - `current/` (`model.stl` plus renders);
  - `passes/` (the M1 pass folders).
- States: `new` → `touching-up` → `ready` | `needs-closeup` | `failed`, then `printing` → `printed` | `failed`. A correction goes `ready` → `touching-up`.
- A touch-up starts by itself when the phone says the inputs are complete (`POST …/start`); there's no other button. With more than 24 photos, an evenly spaced 24 are sent.
- Size comes from the printer MCP's `get_stl_info` on the current model, never from the app's own mesh code.
- Print creates a handoff bundle from `current/model.stl` and prints through the user's printer MCP config, unchanged.
- **Bed check:** when the MCP asks its confirmation with a camera photo, `bedcheck.ts` asks the user's Claude whether anything is on the plate.
  - Clear: answer accept automatically.
  - Not clear: the object enters `printing` with `plate: {item, photoAvailable}`, and the phone shows the photo, "take it off" and "It's actually clear".
- Scopes:
  - reads: `projects:read`;
  - writes and uploads: `captures:import`;
  - print: `printer-handoff:use`.
- No new mesh code, no app-side printer settings, no agent attribution in Git.

## Review Focus

1. **Companion restarts mid-touch-up:** the object must not stay `touching-up` forever. On startup it becomes `failed` with "interrupted", and the phone can start it again.
2. **A second `start` while touching up:** ignored. It returns the current object, not a second pass.
3. **Uploads after `start`:** photos are accepted only in `new` or `needs-closeup`. Otherwise 409.
4. **Printing an object with no current model:** 409 `no-model`.
5. **The bed-check judge fails** (no login, error): never auto-accept. Treat it as not clear, with item "something".

---

### Task 1: Object store
**Files:** create `src/objects/store.ts`. Test: `tests/objects-store.test.mjs`.
**Produces:**
- `type ObjectState = 'new'|'touching-up'|'needs-closeup'|'ready'|'printing'|'printed'|'failed'`
- `interface StmObject {id; createdAtMs; updatedAtMs; instructions?: string; state: ObjectState; scan?: string; photos: string[]; passes: {startedAtMs; endedAtMs?; note?; status?; summary?; seconds?; costUsd?; dir?}[]; current?: {model: string; renders: string[]; sizeMm?: [number, number, number]; summary?: string}; question?: {closeup: string}; plate?: {item: string}; failure?: string; print?: {bundleId: string}}`
- `class ObjectStore {constructor(root); create(instructions?) ; list(): StmObject[] newest first; get(id); update(id, fn); dir(id); addFile(id, kind:'scan'|'photos', name, bytes); recoverInterrupted()}`

Tests:
- create/list/get round-trip;
- list is newest first;
- `update` is atomic (write to a temp file, then rename);
- `addFile` rejects path traversal in names;
- `recoverInterrupted` turns `touching-up` and `printing` into `failed` with "interrupted".

### Task 2: Object service (touch-up orchestration)
**Files:** create `src/objects/service.ts`. Test: `tests/objects-service.test.mjs`, using fake `runTouchup` and `stlInfo`.
**Produces:** `class ObjectService {constructor({store, runTouchup, stlInfo, claudePath, handoff, onChange?}); create; list; get; addScan(id, bytes); addPhoto(id, name, bytes); start(id); correct(id, note); answerCloseup(id, {bestGuess?: boolean}); print(id); answerPlate(id, {clear: true})}`

Tests:
- `start` → `touching-up` → `ready`, with `current.model` copied into `current/`, `sizeMm` from `stlInfo`, and the pass recorded;
- `needs_closeup` → `needs-closeup` with the question;
- `failed` → `failed` with the reason;
- `unchanged` → `ready`, with the summary saying nothing needed changing;
- a second `start` while touching up does nothing (Focus 2);
- uploads after `start` → 409-type error (Focus 3);
- `correct` runs a pass from `current/model.stl` with the note and the last summary, keeping the original instructions;
- `answerCloseup({bestGuess:true})` runs a pass with the note "Make your best guess for the parts you couldn't see";
- more than 24 photos → 24 evenly spaced are sent.

### Task 3: Print with the background bed check
**Files:** create `src/objects/bedcheck.ts`; modify `src/objects/service.ts`. Tests: `tests/objects-print.test.mjs`, using a fake relay, runner and judge.
**Produces:** `judgePlate(photoBase64, claudePath): Promise<{clear: boolean; item?: string}>`. It runs `claude -p` (Sonnet, `--json-schema {clear, item}`, `--tools ""`, `--setting-sources ""`, isolated env as in M1) with the photo, given as a file path read by Read.

Tests:
- `print` with no current model → `no-model` (Focus 4);
- a confirmation with a photo the judge calls clear → auto-accept and `printing`;
- not clear → `plate.item` set, no answer sent;
- `answerPlate({clear:true})` → accept sent;
- judge throws → treated as not clear (Focus 5);
- the print result ends in `printed` or `failed`.

### Task 4: HTTP routes and control socket
**Files:** create `src/objects/http.ts`; modify `src/server.ts` (route `/v1/objects`), `src/server-cli.ts` (wiring: `<captureDir>/objects`, handoff config, `SCAN_TO_MAKE_CLAUDE_PATH`), `src/local-control-protocol.ts` and `src/local-control-services.ts` (methods `objects.list`, `objects.get`, `objects.correct`, `objects.answerCloseup`, `objects.print`, `objects.answerPlate`). Test: `tests/objects-http.test.mjs`, using the existing auth fixture pattern from `capture-http.test.mjs`.

Routes:

| Method | Path | Body | Scope |
|---|---|---|---|
| POST | `/v1/objects` | `{instructions?}` | write |
| GET | `/v1/objects` | | read |
| GET | `/v1/objects/:id` | | read |
| PUT | `/v1/objects/:id/scan` | raw USDZ, ≤ 64 MiB | write |
| POST | `/v1/objects/:id/photos?name=` | raw image, ≤ 20 MiB | write |
| POST | `/v1/objects/:id/start` | | write |
| POST | `/v1/objects/:id/corrections` | `{note}` | write |
| POST | `/v1/objects/:id/closeup` | `{bestGuess:true}` | write |
| GET | `/v1/objects/:id/model.stl` | | read |
| GET | `/v1/objects/:id/renders/:name` | | read |
| POST | `/v1/objects/:id/print` | | print |
| POST | `/v1/objects/:id/plate` | `{clear:true}` | print |

Tests: create, upload, start, poll ready, and model download over HTTPS with a paired-device token; a missing scope gets 403; a path traversal in `name` gets 400.

### Task 5: Live check
Run the companion from the branch on a test port, with a temp data root and the M1 handoff config. Use curl with a paired test device:
- create an object with the potato USDZ and 24 photos;
- `start`;
- poll until `ready`;
- download `model.stl` and check its size.

Then quick `codex review`, push, and merge.
