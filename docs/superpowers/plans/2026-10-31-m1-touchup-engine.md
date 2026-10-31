# Milestone 1: Touch-up Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac-side touch-up engine. It takes a scan and its photos and runs the user's own Claude (Opus 5.5) through the user's printer MCP's Blender bridge. It returns a touched-up STL under app-enforced guard rails. It is proven on real captures before any UI is built.

**Architecture:**
- A new, self-contained module in `services/companion/src/touchup/` with five pieces:
  - isolated inputs;
  - Blender readiness;
  - a fresh scene via the printer MCP bridge;
  - the worker runner with caps, checkpoints and a structured result;
  - an orchestrator.
- Plus a CLI used for the milestone proof.
- Nothing in the existing cleanup pipeline changes. Replacing it is a later plan.

**Tech Stack:** TypeScript (companion, Node 22/24), `node --test` on `dist/`, `@scan-to-make/printer-handoff` (`PrinterMcpClient`), the Claude Code CLI (`claude -p`), Blender 5 with the Blender MCP addon.

**Spec:** `docs/superpowers/specs/2026-10-31-app-rebuild-design.md` (§3 code rule, §6 engine, §8 constraints, §11 milestone 1).

## Global Constraints

- The worker runs the user's own Claude Code login: `claude -p --model claude-opus-5-5 --effort high`.
- **Exactly one MCP server:** the user's printer MCP, bambu-printer-mcp or mcp-3D-printer-server, launched unchanged from its existing `PrinterMcpProcess` config. This app never adds Blender settings to it and never wires a second Blender path.
- **The MCP is the user's installed copy,** the same one their own agent uses (for example `~/bambu-printer-mcp/dist/index.js` on David's Mac). Never the app's bundled or pinned copy. MCPs update several times a week, and the app has to pick that up immediately.
- **Built-in tools:** only `Read`. No skills or slash commands (`--disable-slash-commands`).
- **No personal setup:**
  - `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the worker env;
  - `--settings '{"disableAllHooks":true}'`.
- **Worker env allowlist:** `HOME USER LOGNAME PATH TMPDIR LANG SHELL CLAUDE_CONFIG_DIR`. No printer tokens or provider keys.
- **Instruction:** `Look at the pictures of this, and then tweak the scan based on that.` A correction pass sends the user's note instead.
- **Guard rails:**
  - a fresh empty Blender scene per pass;
  - a per-pass folder holding only that pass's inputs;
  - checkpoints after each fix;
  - hard caps of 900 000 ms and 120 tool calls;
  - one touch-up at a time per Mac.
- **Behaviour:** targeted edits with Blender's own tools; no print prep (bases, orientation, supports); never smooth captured surface; one pass, then stop.
- Correction passes start fresh from the current model with a short summary. Never `--resume`.
- **Git and review:**
  - no credentials or personal captures in Git;
  - no agent attribution in commits or PRs;
  - one KAN-keyed branch;
  - `scripts/ci-local.sh all --changed-only` before the single push.
- Judge results by renders against photos, never by metrics.

## Review Focus

1. **Printer MCP without a working Blender bridge** (not configured, Blender not installed, addon missing): fail fast with a plain message naming the fix, before any worker is spawned. Pinned in Task 3 and Task 6.
2. **Worker ends without a usable model** (auth failure "Not logged in", rate limit, crash, empty or invalid STL): the result is `failed` with the reason, and the last checkpoint is kept if there is one. Never `done`. Pinned in Task 4.
3. **Worker returns the scan unchanged:** the result is `unchanged`, never `done`. Pinned in Task 4.
4. **Photos arrive as HEIC, very large, or not at all:** HEIC and oversized images become JPEG with a long edge ≤ 2048 px. Zero photos is refused before spawning. Pinned in Task 1.
5. **Two touch-ups requested at once** (one Blender, one scene): the second waits for the first. It never runs concurrently. Pinned in Task 5.

---

### Task 0: Ticket and branch

- [ ] **Step 1:** Create the KAN story "M1: touch-up engine through the user's printer MCP" under epic KAN-80. Use `python3 ~/.config/scan-to-make/stm_jira.py create --summary "…" --parent KAN-80 --labels owner-claude,rebuild-m1`, then transition it to Doing.
- [ ] **Step 2:** Create the branch `KAN-202-m1-touchup` from `origin/main` in its own worktree (`git worktree add ../stm-wt/KAN-202-m1 -b KAN-202-m1-touchup origin/main`).

### Task 1: Isolated pass folder

**Files:**
- Create: `services/companion/src/touchup/inputs.ts`
- Test: `services/companion/tests/touchup-inputs.test.mjs`
- Test fixtures: `services/companion/tests/fixtures/touchup/` (one tiny `.obj` + `.mtl` + `.png` texture, one `.jpg`, one `.heic`)

**Interfaces:**
- Produces:
  - `prepareTouchupPass(input: {root: string; objectId: string; scan: string[]; photos: string[]}): Promise<TouchupPass>`
  - `interface TouchupPass {dir: string; scanDir: string; scanPaths: string[]; photosDir: string; photoPaths: string[]; outDir: string; checkpointsDir: string}`
  - `class NoPhotosError extends Error`
- `scan` is the model file plus its sidecars (`.mtl`, texture) or a single STL. Folder layout: `<root>/<objectId>/<ISO-timestamp>/{scan,photos,out,out/checkpoints}`.

- [ ] **Step 1: Write the failing tests.** Each runs in a temp root.
  - `copies only the given files`: list the pass dir recursively. Expect exactly `scan/<names>`, `photos/photo-01.jpg…`, and empty `out/` and `out/checkpoints/`. Assert that a sibling file next to an input is **not** copied.
  - `converts HEIC and caps size`: given the `.heic` fixture plus a 4000 px JPEG, every file in `photos/` ends `.jpg`, and `sips -g pixelWidth -g pixelHeight` reports a long edge ≤ 2048.
  - `refuses zero photos`: `prepareTouchupPass({…photos: []})` rejects with `NoPhotosError`, and no dir is created.
  - `each pass gets a new folder`: two calls for the same `objectId` return different `dir`s.
- [ ] **Step 2:** Run `cd services/companion && npm run build && node --test tests/touchup-inputs.test.mjs`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement `prepareTouchupPass` in `inputs.ts`. Convert with `/usr/bin/sips -s format jpeg -Z 2048 <in> --out <out>`, using `execFile`, never a shell. Name photos `photo-NN.jpg` in input order.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(companion): KAN-202 isolated touch-up pass folder`.

### Task 2: Worker invocation

**Files:**
- Create: `services/companion/src/touchup/invocation.ts`
- Test: `services/companion/tests/touchup-invocation.test.mjs`

**Interfaces:**
- Consumes: `TouchupPass` (Task 1) and `PrinterMcpProcess` (from `@scan-to-make/printer-handoff`'s config: `{command, args?, cwd?, env?}`).
- Produces:
  - `buildTouchupInvocation(input: {pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; note?: string; summary?: string; sourceEnv?: NodeJS.ProcessEnv}): TouchupInvocation`
  - `interface TouchupInvocation {command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; mcpConfigPath: string; mcpConfig: {mcpServers: {printer: {command: string; args: string[]; env?: Record<string,string>}}}}`
  - `const TOUCHUP_RESULT_SCHEMA`
  - `const TOUCHUP_SYSTEM_RULES`

`TOUCHUP_RESULT_SCHEMA` (exact):
```json
{"type":"object","additionalProperties":false,"required":["status","summary"],
 "properties":{"status":{"enum":["done","needs_closeup"]},
  "closeup":{"type":"string","description":"What to photograph, in a few plain words"},
  "summary":{"type":"string","description":"What was changed, one short paragraph"}}}
```

`TOUCHUP_SYSTEM_RULES` (exact copy, appended with `--append-system-prompt`):
```
You are touching up a 3D scan so it matches the real object in the photos.
- Reach Blender only through the printer MCP's blender_mcp_* tools. Start in the empty scene you are given.
- Make targeted edits only where the photos show the scan is wrong. Leave everything the scanner captured well as it is, and never smooth captured surface.
- Use Blender's own tools (sculpt brushes, modifiers limited to a region, primitives). Don't write your own geometry algorithms.
- Don't do print preparation: no flat bases, re-orientation or supports.
- After each fix, export the whole model as an STL to the checkpoints folder (01.stl, 02.stl, …).
- Make one pass, then stop. Export the final model to out/touched.stl and a few PNG renders to out/.
- If you can't see a part well enough to fix it, set status to needs_closeup and say what to photograph.
```

User prompt (exact). First pass: line 1 is the Global Constraints instruction; a correction pass starts instead with `This is the current model. ${summary}\n\nChange requested: ${note}`. Then:
```
Files:
- Scan: <scanPaths joined by ", ">
- Photos: <photosDir>/photo-01.jpg … photo-NN.jpg
- Checkpoints folder: <checkpointsDir>
- Output folder: <outDir>
```

- [ ] **Step 1: Write the failing tests.**
  - `args are exactly the lean worker`: `args` contains, in any order:
    - the pairs `--model claude-opus-5-5`, `--effort high`, `--mcp-config <mcpConfigPath>`, `--tools Read`, `--allowedTools Read,mcp__printer`, `--output-format stream-json`, `--json-schema <JSON.stringify(TOUCHUP_RESULT_SCHEMA)>`, `--settings {"disableAllHooks":true}`, `--append-system-prompt <TOUCHUP_SYSTEM_RULES>`;
    - the flags `-p`, `--strict-mcp-config`, `--disable-slash-commands`, `--verbose`;
    - and no `--resume`.
  - `env is the allowlist plus isolation`: from a `sourceEnv` containing `HOME, USER, PATH, BAMBU_TOKEN, ANTHROPIC_API_KEY`:
    - env has `HOME USER PATH`;
    - env has `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
    - env lacks `BAMBU_TOKEN` and `ANTHROPIC_API_KEY`.
  - `printer MCP is passed through unchanged`: given `{command:'/usr/bin/ssh', args:['-T','x@127.0.0.1'], env:{MCP_TRANSPORT:'stdio'}}`, `mcpConfig.mcpServers` has exactly one key, `printer`, whose command, args and env equal the input. Given `cwd`, the server is `/bin/sh -c 'cd <cwd> && exec <command> <args…>'` with every argument shell-quoted. Assert this with a cwd containing a space.
  - `correction prompt never resumes`: with `note` and `summary`, the prompt starts with `This is the current model.` and contains the note. No `--resume` appears.
  - `cwd is the pass dir`: `cwd === pass.dir`, and `mcpConfigPath` sits inside `pass.dir`.
- [ ] **Step 2:** Run `npm run build && node --test tests/touchup-invocation.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement `buildTouchupInvocation` in `invocation.ts`. Write `mcp.json` into `pass.dir`. The prompt is the final positional argument after `-p`.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5: Verify the CLI contract once, by hand.** Run `claude -p "Reply with status done and summary ok." --json-schema '<schema>' --output-format stream-json --verbose --tools Read`. Expect the final `type:"result"` line to carry the structured object. Record its field name (expected `structured_output`) in a code comment next to `TOUCHUP_RESULT_SCHEMA`. Task 4 parses that field.
- [ ] **Step 6:** Commit: `feat(companion): KAN-202 lean touch-up worker invocation`.

### Task 3: Blender readiness and a fresh scene through the printer MCP

**Files:**
- Create:
  - `services/companion/src/touchup/blender.ts`
  - `services/companion/blender/start_blender_mcp.py`: enables the addon, then starts its server on a timer. Copy from `~/scan-to-make-work/touchup/start_blender_mcp.py`.
- Test: `services/companion/tests/touchup-blender.test.mjs`

**Interfaces:**
- Produces:
  - `ensureBlenderMcp(opts: {port?: number /*9876*/; launch: () => Promise<void>; timeoutMs?: number /*60000*/}): Promise<'already-running'|'launched'>`
  - `defaultBlenderLaunch(blenderApp = '/Applications/Blender.app', script: string): () => Promise<void>`: runs `open -g -j -n -a <app> --args --python <script>`.
  - `resetBlenderScene(client: Pick<PrinterMcpClient,'connect'|'callTool'|'close'>, signal?: AbortSignal): Promise<void>`
  - `class BlenderNotReadyError extends Error`
  - `class BlenderBridgeUnavailableError extends Error`. Its message is exactly `Blender isn't set up in your printer MCP. Add BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS to its config.`

- [ ] **Step 1: Write the failing tests.**
  - `already running`: with a local TCP listener on a random port, the result is `'already-running'` and `launch` is never called.
  - `launches and waits`: with a `launch` fake that opens the listener after 200 ms, the result is `'launched'`.
  - `times out`: with a `launch` that never listens and `timeoutMs: 500`, it rejects with `BlenderNotReadyError`.
  - `reset goes through the bridge`: with a fake client, the calls are exactly:
    1. `blender_mcp_status {connect:true}`;
    2. `blender_mcp_call {tool_name:'execute_blender_code', arguments:{code:<removes all objects and orphan data>, user_prompt:'Start a fresh, empty scene for a scan touch-up'}}`.
  - `bridge not configured`: when the fake `blender_mcp_status` returns `{configured:false}`, or the tool is missing, it rejects with `BlenderBridgeUnavailableError` and `blender_mcp_call` is never called.
- [ ] **Step 2:** Run `npm run build && node --test tests/touchup-blender.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement in `blender.ts`. Poll the port with `net.connect` every 250 ms.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(companion): KAN-202 Blender readiness and fresh scene via the printer MCP bridge`.

### Task 4: Worker runner with caps, checkpoints and a structured result

**Files:**
- Create: `services/companion/src/touchup/runner.ts`
- Test: `services/companion/tests/touchup-runner.test.mjs` (fake `spawn` that emits canned stream-json lines from `tests/fixtures/touchup/streams/*.jsonl`)

**Interfaces:**
- Consumes: `TouchupInvocation` (Task 2) and `TouchupPass` (Task 1).
- Produces:
  - `runTouchupWorker(inv: TouchupInvocation, pass: TouchupPass, opts?: {spawn?: typeof import('node:child_process').spawn; timeoutMs?: number /*900000*/; maxToolCalls?: number /*120*/; inputStlSha256?: string; onProgress?: (p: {seconds: number; toolCalls: number; lastText?: string}) => void; signal?: AbortSignal}): Promise<TouchupResult>`
  - `interface TouchupResult {status: 'done'|'unchanged'|'needs_closeup'|'capped'|'failed'; reason?: string; closeup?: string; summary?: string; model?: string; renders: string[]; checkpoints: string[]; stats: {seconds: number; toolCalls: number; costUsd?: number}}`
- Final model rule: `out/touched.stl` if present and non-empty, else the highest-numbered checkpoint, else none.

- [ ] **Step 1: Write the failing tests.** One per fixture stream.
  - `done`: the stream ends with `result` plus structured `{status:'done', summary:'…'}`, and the fake writes `out/touched.stl`. Expect `status 'done'`, `model` ending `out/touched.stl`, `toolCalls` equal to the number of `tool_use` blocks, and `costUsd` from `total_cost_usd`.
  - `needs_closeup`: structured `{status:'needs_closeup', closeup:'the underside'}`. Expect `status 'needs_closeup'` and `closeup 'the underside'`.
  - `tool-call cap`: the stream has 130 `tool_use` blocks, and checkpoints `01.stl` and `02.stl` exist. With `maxToolCalls: 120`, expect the process group killed, `status 'capped'`, and `model` ending `checkpoints/02.stl`.
  - `time cap`: the stream never ends, and `timeoutMs: 300`. Expect `status 'capped'`.
  - `auth failure`: the stream's result text contains `Not logged in`, the exit code is 1, and there's no output. Expect `status 'failed'` with `reason` containing `Not logged in`, and no `model`.
  - `unchanged`: `out/touched.stl` has the same SHA-256 as `inputStlSha256`. Expect `status 'unchanged'`.
  - `invalid output`: `out/touched.stl` is 0 bytes and there are no checkpoints. Expect `status 'failed'` with `reason 'no model was saved'`.
- [ ] **Step 2:** Run `npm run build && node --test tests/touchup-runner.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement `runTouchupWorker` in `runner.ts`. Spawn detached with `inv.env` and `inv.cwd`, and parse stdout line by line. Kill the group with SIGTERM, then SIGKILL after 5 s, the same pattern as `model-access-worker.ts`. Read the structured object from the field recorded in Task 2 Step 5.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit: `feat(companion): KAN-202 touch-up worker runner with caps and checkpoints`.

### Task 5: Orchestrator, single-flight, and the milestone CLI

**Files:**
- Create:
  - `services/companion/src/touchup/touchup.ts`
  - `services/companion/src/touchup-cli.ts`
- Test: `services/companion/tests/touchup-orchestrator.test.mjs`

**Interfaces:**
- Consumes: everything above. The printer MCP process comes from `readPrinterHandoffConfig(path)` in `@scan-to-make/printer-handoff`, so the user's existing config is used as is.
- Produces:
  - `runTouchup(input: {root: string; objectId: string; scan: string[]; photos: string[]; printer: PrinterMcpProcess; claudePath: string; note?: string; summary?: string}, deps?: {ensureBlender?; resetScene?; prepare?; run?; client?}): Promise<TouchupResult & {passDir: string}>`
  - The CLI `node dist/touchup-cli.js --object <id> --scan <file…> --photos <dir> --handoff-config <path> [--note <text> --summary <text>] [--root <dir>]`. It prints progress lines and writes `<passDir>/report.json` with the full `TouchupResult` plus `printerBackend` and `startedAt`.
- One touch-up at a time: a module-level promise chain.

- [ ] **Step 1: Write the failing tests.**
  - `order`: with recording fakes, the calls happen as `ensureBlender → resetScene → prepare → run`.
  - `bridge missing stops early`: when `resetScene` throws `BlenderBridgeUnavailableError`, `run` is never called and the error propagates unchanged.
  - `one at a time`: two concurrent `runTouchup` calls whose fake `run` resolves after 100 ms. Expect the second `ensureBlender` to start only after the first `run` resolves.
  - `correction pass`: given `note` and `summary`, `scan` is the previous model's path. Expect `prepare` to receive it, and the invocation's prompt to start with `This is the current model.`.
- [ ] **Step 2:** Run `npm run build && node --test tests/touchup-orchestrator.test.mjs`. Expect FAIL.
- [ ] **Step 3:** Implement `touchup.ts` and the CLI. The default `claudePath` comes from `SCAN_TO_MAKE_CLAUDE_PATH`, else `claude` on PATH, resolved to an absolute path.
- [ ] **Step 4:** Run `npm run build && node --test tests/touchup-*.test.mjs`. Expect all touch-up tests PASS.
- [ ] **Step 5:** Run `npm test` in `services/companion`. Expect the existing suite still passes, with no regressions.
- [ ] **Step 6:** Commit: `feat(companion): KAN-202 touch-up orchestrator and milestone CLI`.

### Task 6: Milestone proof on real captures (ops, no new code)

- [ ] **Step 1: Enable the Blender bridge in the user's printer MCP configs.** This is a change to David's own MCP configs, so get his OK in chat first.
  - Add `BLENDER_MCP_COMMAND=/opt/homebrew/bin/uvx` and `BLENDER_MCP_ARGS=["blender-mcp"]` to `~/bambu-printer-mcp/.env`.
  - Add the same settings to the mcp-3D-printer-server config that `~/scan-to-make-work/touchup/m1/mcp3d-handoff.json` launches. Write that file: backend `mcp-3d-printer-server`, process `node /Users/davidmontgomery/mcp-3D-printer-server/dist/index.js`, cwd that repo.
  - Verify with the bridge check through each MCP: `blender_mcp_status {connect:true}` reports `connected: true`.
- [ ] **Step 1b: Point the app at the user's installed MCPs, not its bundled copy.** The live `printer-handoff.json` currently launches the app's pinned bambu-printer-mcp 1.1.42 from `releases/install-*/printers/bambu/`. Change it, and the SSH stopgap's forced command, to the user's install: `~/bambu-printer-mcp/dist/index.js` with cwd `~/bambu-printer-mcp`. Keep backups. Verify with `get_printer_status` that the reported server version matches `~/bambu-printer-mcp/package.json`.
- [ ] **Step 2: Get the scan's own photos.** Copy the Object Capture `Images/` folders for two captures from David's iPhone (`Davica3`): the crochet scan and the AirPods case. Use `xcrun devicectl device copy from --device <id> --domain-type appDataContainer --domain-identifier com.scantomake --source Documents --destination ~/scan-to-make-work/touchup/m1/phone/`. Then locate each capture's `Images/`.
  - Expect dozens of HEIC images per capture.
  - If the app didn't keep them for these captures, scan one new object on the phone and use that.
- [ ] **Step 3: Run the CLI four times:** two captures × two printer MCPs. Use each capture's textured model from `~/Library/Application Support/Scan to Make/capture/captures/<id>/` (`mesh.obj`, `mesh.mtl`, `mesh_basecolor_0.png`) and **only** the Object Capture photos.
  - Expect a `report.json` per run with a status other than `failed`, and `seconds` < 900.
- [ ] **Step 4: Judge each run by eye.** Render the result next to the photos from the same angles, using the renders in `out/` plus three photos per object.
  - Pass if:
    - the obvious photo-visible defects are fixed;
    - nothing the scanner captured well has been smoothed;
    - there's no print-prep geometry;
    - the worker stopped by itself under the caps.
  - Run one correction pass on one object with a one-sentence note, and record its time.
- [ ] **Step 5: Record the outcome on the KAN ticket, not in the spec.** For each run: time, tool calls, cost, pass or fail, and the contact-sheet paths. Then decide:
  - If both printer MCPs pass on both captures, the milestone is done, and the next plan (phone and Mac UI) starts.
  - If the scan's own photos weren't enough, write down what was missing and propose the capture/send change before any UI work.
  - If one MCP's bridge falls short, file the fix in that MCP's repo under its AGENTS.md.
- [ ] **Step 6: Ship.**
  - Run `scripts/ci-local.sh all --changed-only` and paste the summary into the PR and the ticket.
  - Push once with `@codex review` in the commit message, and open the PR. The body names the printer-MCP capabilities used: `blender_mcp_status`, `blender_mcp_call`, plus `readPrinterHandoffConfig`.
  - Move the ticket to Review.
