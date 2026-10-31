# AI tweak (KAN-183)

The cleanup's AI step hands a coding agent the textured scan and the close-up
photos, with one sentence and nothing else:

> Look at the pictures of this, and then tweak the scan based on that.

The KAN-177 experiment found that this beats a structured correction prompt, as
long as the agent runs **sealed**: it sees only the scan and the photos, and
none of the user's own agent setup. One run can still damage the scan, so the
companion runs several attempts. A visual pick (KAN-184) chooses one of them, or
keeps the raw scan, and a make-printable step (KAN-185) follows.

`src/ai-tweak.ts` runs the attempts and records what happened. It is not wired
into the cleanup job yet: the published geometry has to come from the visual
pick, which lands with KAN-184.

## Model access

The companion has one setting, `ModelAccess` (journey.md §3.6). The Mac app sets
it in the companion's environment and puts any key in an environment variable
that it names. Keys are never written to disk or to the manifest.

| `SCAN_TO_MAKE_AI_ACCESS` | Runs | Signs in with |
| --- | --- | --- |
| `none` (default) | nothing; the step is skipped | — |
| `claude-code` | the user's own `claude -p` | the user's Claude Code login |
| `codex-cli` | the user's own `codex exec` | the user's Codex login |
| `api` + `SCAN_TO_MAKE_AI_PROVIDER=anthropic` | `claude -p` | the key in `SCAN_TO_MAKE_AI_KEY_ENV` |
| `api` + `SCAN_TO_MAKE_AI_PROVIDER=openai` | `codex exec` | the key in `SCAN_TO_MAKE_AI_KEY_ENV` |
| `endpoint` + `SCAN_TO_MAKE_AI_ENDPOINT` | `codex exec` against that URL | optional key in `SCAN_TO_MAKE_AI_KEY_ENV` |

- **Other settings:**
  - `SCAN_TO_MAKE_AI_MODEL` (Claude: `claude-opus-5-5`; Codex: `gpt-6-astra`);
  - `SCAN_TO_MAKE_AI_EFFORT` (Codex reasoning effort; default `xhigh`);
  - `SCAN_TO_MAKE_AI_ATTEMPTS` (1–4, default 2);
  - `SCAN_TO_MAKE_AI_TIMEOUT_MS` (default and maximum 30 minutes per attempt).
- **Executables:**
  - `SCAN_TO_MAKE_CLAUDE_PATH` and `SCAN_TO_MAKE_CODEX_PATH`. Without them, the CLI looks on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
  - `SCAN_TO_MAKE_SCAN_BLENDER` is exposed to the agent as `blender`.
  - `SCAN_TO_MAKE_CAPTURE_PYTHON` prepares the photos, and its `bin` directory is on the agent's `PATH`.
- **Endpoints:** an endpoint must speak the OpenAI Responses API, because Codex 0.166 no longer accepts `wire_api = "chat"`.
- **Invalid settings:** an unknown kind, a malformed model name or a URL with embedded credentials fails closed.

## Sealing

Each attempt gets a fresh temporary folder. Its only child, `scan/`, holds:

- `mesh.obj`, `mesh.mtl` and its textures;
- `original.usdz`;
- every close-up photo, as an upright, full-resolution `still_NN_<hash>.jpg`. EXIF rotation is applied and HEIC is decoded.

The files are read-only. Pristine copies stay outside the folder, in `inputs/` of the output directory.

**Claude Code** runs as:

```
claude -p "<sentence>" --model <model> --dangerously-skip-permissions --setting-sources ''
  --settings '{"disableAllHooks":true,"autoMemoryEnabled":false,"enabledPlugins":{}}'
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format stream-json --verbose
```

The settings are inline JSON, so no path appears in its arguments. It also gets
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
`ENABLE_CLAUDEAI_MCP_SERVERS=false`. These keep the user's CLAUDE.md, rules,
memory, hooks, plugins and MCP servers out of the run without signing it out.
(`--bare` would drop the subscription login.)

**Codex** runs as:

```
codex exec "<sentence>" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -o <file>
```

It runs with a fresh `CODEX_HOME` that holds only:

- a copy of the user's `auth.json`;
- a `config.toml` with the model, the effort, and the user's ChatGPT apps, plugins and memories turned off.

Codex's built-in system skills remain, as Claude Code's bundled skills do.

Codex also gets a private, empty `HOME`, because Codex finds user skills
(`~/.agents/skills`) and shell profiles through `HOME`. Its sign-in is read
from the user's real home before the run.

If Codex refreshes its sign-in during the run, the refreshed `auth.json` is
written back to the user's file. That happens only if the user's file is
unchanged since the copy; otherwise the conflict is recorded. Parallel attempts
do this one at a time. The copy is deleted afterwards.

ChatGPT refresh tokens rotate, so two attempts refreshing the same copied token
at once would leave only one valid. Before parallel `codex-cli` attempts, one
tiny sealed call ("Reply with the single word OK.") runs first. If a refresh is
needed, it happens there, once, and is written back; the manifest records it as
`warmup`.

**Both CLIs** get an environment built from scratch:

- `HOME`, `USER`, `LANG`, `SHELL`;
- a `PATH` holding `blender`, the CLI's own directory and the system directories;
- a private `TMPDIR`;
- `CLAUDE_CONFIG_DIR` if the user sets one;
- the one key that the access kind needs.

Nothing else from the companion's environment is passed on. An inherited
`ANTHROPIC_API_KEY` would otherwise move a subscription run onto API billing.

Claude Code keeps the user's real `HOME`, because its sign-in lives there. Its
Bash tool therefore still starts from the user's shell configuration.

stdin is closed. The prompt is passed as the argument and nowhere else.

Attempts keep the experiment's permissions: no CLI sandbox, so an agent can run
Blender and Python freely. Its writes are not confined to the folder. The sealing
controls what the agent is *told*, not what it can reach.

## GUI session

Claude Code reads its subscription login from the macOS login keychain. That
keychain is locked to SSH and background sessions, where Claude Code reports
"Not logged in". For `claude-code`, an attempt first checks
`launchctl managername`. Outside an `Aqua` session, the attempt ends as
`needs-gui-session` without starting the CLI.

The companion's LaunchAgent and the Mac app's agent both run in the user's GUI
session. The Codex, API and endpoint routes do not need one.

## Supervision and limits

- **Process groups:** each CLI runs in its own process group.
- **Leftover processes:** descendants are tracked by parent links while the CLI runs, and by a per-attempt environment marker that every descendant inherits. Workers that call `setsid`, or are reparented after their parent exits, are therefore still found.
- **When attempts stop:** on a timeout or cancellation, every tracked process gets SIGTERM, then SIGKILL three seconds later. When the CLI exits, anything left behind is killed straight away, including a worker that still holds the CLI's output pipes.
- **Limits:** the transcript, the error log, and the workspace's byte and file counts are all bounded. Exceeding a limit stops the attempt.
- **Clean-up:** the sealed folder and the private `CODEX_HOME` are deleted afterwards.

## Output

`runAiTweak(input, out, options)` creates `out` and writes `out/ai-tweak.json`
(`scan-to-make.ai-tweak/0.1`). It returns the same manifest.

```
out/
  ai-tweak.json      prompt, access (kind/model/host, never a key), input hashes, attempts
  inputs/            pristine copies offered to every attempt
  attempt-N/
    result/          the collected OBJ bundle (OBJ + MTL + textures, relative layout kept)
    logs/            transcript.jsonl, stderr.log, claude-session.jsonl or codex-rollout.jsonl, last-message.txt
```

**Collecting a result.** The collector walks the workspace and skips symlinks and
hidden folders such as `.work`. Every OBJ there is resolved to its bundle. Each
`mtllib` and texture reference must stay inside the workspace, with no symlink
anywhere on its path, and options like `-bm 1.0` before a texture name are
handled. Absolute references into the workspace are rewritten as relative ones
when the bundle is copied.

- A bundle whose bytes match the inputs (an agent's backup copy) is not a result.
- The most recently written changed bundle is chosen. Other changed bundles are listed as `alternates`.
- An agent that edits files in place is handled, and `inputsModified` says which inputs changed.
- An agent that edits only the texture still produces a result, because the bundle's bytes changed.

**Outcomes:**

| Outcome | Meaning |
| --- | --- |
| `changed` | a changed OBJ bundle was collected |
| `unchanged` | the agent finished without changing the scan |
| `other-format-only` | it wrote only GLB/USDZ/STL/etc. |
| `invalid-output` | its OBJ bundle referenced missing files or files outside the workspace |
| `failed` | the CLI is missing or exited with an error |
| `auth-failed` | not signed in, or the key was rejected |
| `needs-gui-session` | see above |
| `timed-out` | the attempt hit its time limit |
| `cancelled` | the attempt was cancelled |

The manifest also records:

- **Seal evidence:**
  - Claude: the model, `apiKeySource`, MCP servers, plugins, hook-event count, attachment types, and whether the only user message was the sentence.
  - Codex: the model and effort from the rollout, the developer-message headings, and whether the only user message was the sentence.
- **For each attempt:** the CLI version, wall time and the CLI's own usage report.

A Claude session file is moved out of `~/.claude/projects` into the attempt's
logs, so sealed runs don't appear in the user's Claude Code history.

`checkModelAccess(options)` makes the Mac app's **Connected** check. It sends one
tiny sealed call ("Reply with the single word OK.") through the same route and
reports `ok` with the same outcome names.

## Command line

```sh
node dist/ai-tweak-cli.js run --mesh /abs/imported/mesh.obj --usdz /abs/original.usdz \
  --still /abs/a.img --still /abs/b.img --out /abs/new-dir [--attempts 2] [--timeout-ms 1800000]
node dist/ai-tweak-cli.js check
```

Both read the settings above from the environment.

## Not done here

- **Wiring into the cleanup job (KAN-184).**
  - Today the job selects at most four stills for `scan-correct`. The AI step should get every retained photo, which changes the still selection and possibly the contract's cap.
  - Attempts take several minutes to about 20 each, which doesn't fit the job's 30-minute cap alongside the other stages.
  - Attempts in parallel can still collide in shared scratch paths that an agent hard-codes outside `TMPDIR`, such as `/tmp/scanwork`.
- **Write confinement.** It would be a separate change, with its own visual check, because a sandbox changes how the agents work.
- **Printing.** Slicing and printing stay in `bambu-printer-mcp`. Its `blender_mcp_edit_model` (decimate, remesh and boolean union on STL) doesn't fit this step, which edits a textured OBJ freely from photos in a run with no MCP. Its union may fit KAN-185's shell fusing.
