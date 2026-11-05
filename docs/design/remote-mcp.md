# Remote MCP: `/v1/mcp`

Status: design for handoff item 16, revised after council rounds 1 and 2; implemented in `printer-handoff/src/remote-mcp.ts` and `companion/src/remote-mcp-http.ts`. David, Nov 3: "it sounds like the MCP companion
needs to serve a hell of a lot more behind that. V1/*endpoint." Today `/v1` reaches about a dozen of the 54
bambu-printer-mcp tools and the 42 mcp-3D-printer-server tools. This adds one MCP endpoint that passes the configured
printer MCPs through, behind the companion's existing front door.

## What it reuses, and what is new

Reused:
- the companion's one listener and its request checks in `server.ts`;
- device pairing, tokens, refresh and revocation (`remote-auth.ts`; NET-001: per-device pairing, no Funnel);
- each destination's existing `PrinterSession` (PRD §8.3) and elicitation relay;
- `PrintGate`;
- the MCP SDK.

There is no new listener, port, auth system or MCP process.

New:
- a stateless Streamable HTTP route;
- five scopes and the classes the MCPs declare;
- an argument policy;
- remote attribution on questions;
- a `pair-mcp` command;
- small extensions to `PrinterMcpClient` and `PrinterSession`: prompts and resources, server capabilities, and a
  transparent result for remote calls.

## Front door

`/v1/mcp` is mounted behind the same `handler` as every other `/v1` route, in whichever transport the companion was
initialized with.

- **Tailscale mode:**
  - Serve's identity header must be present, with an allowed `Tailscale-User-Login`;
  - the exact `Host` and `X-Forwarded-Host`;
  - `X-Forwarded-Proto: https`;
  - a Funnel request is refused.
- **LAN mode:** TLS with the certificate that pairing pinned, and an exact `Host` allowlist. That allowlist includes the
  Mac's tailnet address when `SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1`.

Both modes then require a paired device token: `Authorization: Bearer <token>` and `X-Scan-Device: <deviceId>`. The
exact `Host` check is what stops DNS rebinding. Any `Origin` header is also refused.

**Facts about the installed Mac (Nov 4):**
- the companion is in **LAN mode**, bound to `192.168.68.123:9077`;
- `SCAN_TO_MAKE_LAN_ALL_ADDRESSES` is not set;
- its certificate names only `IP:192.168.68.123`;
- **Tailscale is not installed** (no app, no CLI, no `100.x` address).

A cloud session therefore has **no network path to this companion today**. This change does not alter that, because it
does not touch Tailscale or the Mac's configuration. It needs one of these, which is David's choice (open question 1):
1. Install Tailscale and run the companion in Serve mode (`init` with the `ts.net` host): the designed path.
2. Install Tailscale and advertise the LAN subnet. The client then reaches `https://192.168.68.123:9077` and trusts the
   pinned certificate (`NODE_EXTRA_CA_CERTS`).
3. `SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1` with a certificate that also names the tailnet address. Today's certificate
   doesn't, so a generic client's hostname check would fail.

`/v1/mcp` is mounted on the same door as the rest of `/v1`, in either mode, so whichever David picks needs no code
change.

## Route and destination selection

- `POST /v1/mcp` serves `current`, the Mac app's own printer.
- `POST /v1/mcp/<destinationId>` serves another configured destination.
- An unknown id returns 404.

We chose a path selector over renaming tools `<printer>__<tool>`. With a path, tool names, prompt text and resource URIs
pass through byte for byte. The MCPs' FDM-guidance prompts and tool descriptions name other tools ("call
`slice_stl`"), and renaming would make that text wrong.

`server-cli.ts` builds one `destinationId → PrintHandoffServices` map whenever printer handoff is configured. It holds
`current` and every other profile, whether or not objects are set up. It passes that map to `startCompanionServer` (`remoteMcp: {destinations, gate,
bundleRoot}`). The route uses each entry's `runner.session` and `relay`, and never calls `pool.session()`.

Transport:
- **Stateless:** the SDK's `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and
  `enableJsonResponse: true`.
- **One SDK `Server` per request.** It advertises `tools`, plus `prompts`/`resources` only when the upstream declared
  them at initialize.
- **Limits:** 1 MiB of JSON. `GET` and `DELETE` return 405.
- **Elicitation is never offered** to the remote client.

## Authorization

- **Before the body is read,** the token must be valid and hold `mcp:read`. `pair-mcp` always grants `mcp:read`.
  Phone pairing (`PHONE_SCOPES`) is unchanged and never grants an `mcp:*` scope. The new values extend the shared
  `RemoteScopeSchema`, so a companion build older than this one refuses a store that holds an `mcp:*` device. To roll
  back, revoke those devices first.
- **Scopes are checked per JSON-RPC method** inside the SDK handlers, so a batch is checked message by message.
  `RemoteAuthStore.device(login, id, token)` returns `{deviceId, deviceName, scopes}`.
- **The token and the path arguments are checked again in `beforeDispatch`,** after the mutex is acquired and right
  before the upstream request. This covers tools, prompts and resources. A device revoked while queued never
  dispatches.

## Scopes and tool classes

| Scope | Grants |
| --- | --- |
| `mcp:read` | `read` tools, `prompts/*`, listed `resources/*` (always granted) |
| `mcp:design` | `design` tools: local model, slicing and file work; writes only to the device's own folder |
| `mcp:control` | `control` tools: pause, resume, stop, temperatures, fans, light, speed, AMS, skip, HMS clear, route |
| `mcp:print` | `print` tools: start a print, upload a file, delete printer files |
| `mcp:raw` | `raw` tools: arbitrary RPC, G-code or code, and tools with no annotations. Off unless chosen at pairing |

Classes rank `read < design < control < print < raw`. Each printer MCP declares every tool's class in its
`_meta["counterpart/remote"]` (bambu-printer-mcp 1.1.64+, mcp-3d-printer-server 1.2.42+; PRD §8.0 item 5), so a new tool
or argument needs no Counterpart release:
- `scope` is the tool's class. A tool without a declaration (an older MCP) is `raw`. Counterpart reads no tool names
  or annotations.
- `raisedBy` names boolean arguments that raise one call's class: `fusion_mcp_status` with `launch: true` and
  `blender_mcp_status` with `connect: true` start a program, so those calls count as `design`. A call is never lowered.

The declarations equal the class table Counterpart kept by hand before (overrides, then annotations, then name floors)
on every tool both MCPs list. The name floors now live in the MCPs' own tests (`tests/tool-annotations.test.mjs`).

`tools/list` shows only the tools the device's scopes allow. Any other `tools/call` gets "tool not available", whether
or not the tool exists.

Granting `mcp:print` means **unattended printing**. David decided there is no ordinary "needs a yes before printing"
prompt ("Decisions already made"). A print asks only when the MCP itself asks, for example when the deployment sets
`BAMBU_REQUIRE_CONFIRMATION`. `pair-mcp` prints this warning when `print` is chosen. Open question 3 asks whether
remote prints should always ask.

## Argument policy

This applies to `tools/call` and `prompts/get` arguments, at any depth. A refusal is an MCP tool error naming the
argument, and nothing reaches the MCP.

1. **Refused keys.** The destination's `.env` chooses the printer, account, hardware and programs. The MCP declares
   those arguments `config` (refused at any depth) or `config-top` (refused as a top-level argument: the printer
   `type`), and they are left out of the schema a device sees. A tool that forwards an open object (an RPC payload,
   another server's tool arguments) declares every configuration name.

   **Injected.** When a tool's schema takes `bambu_model` or `nozzle_diameter`, the route fills them from the
   destination's `selection` after the check, because bambu-printer-mcp requires `bambu_model` on `slice_stl`,
   `inspect_print_file` and `print_3mf`. It also fills the printer target Counterpart's own calls send
   (`counterpart.ts` `routeArgs`), so a remote call reaches the same printer. The caller cannot set any of them.
2. **Path keys.** The MCP declares the arguments that are files it reads (`path`) or writes (`output`). A path value is
   split on `;`, and every part must meet all of these:
   - be absolute, with no `~` and no `..` segment;
   - have its parent directory's `realpath` plus basename land inside the allowed root;
   - not be a symlink, if it already exists.
3. **Allowed roots:**
   - **writes:** `output` arguments and every path argument of a non-`read` tool go only to
     `<bundle store>/remote/<deviceId>/`, created with mode 0700 on first use. Nothing a remote device writes can
     replace a bundle or manifest that the phone or ObjectService prints;
   - **reads:** `path` arguments of `read` tools may also point anywhere in the bundle store.
4. **Path-like text elsewhere is refused.** This covers any other string value containing `/` or `\`, starting with
   `~`, or containing `..`, such as `"boolean_union:/outside/model.stl"`.
5. **Resources:** `resources/read` accepts only URIs from the upstream's `resources/list`. Templates aren't passed
   through, because `printer://{host}/…` would let a caller choose the host.

**Prompts** carry no declarations: their arguments get rule 4 only.

## Confirmations

The remote client is never offered elicitation, so a remote session cannot answer its own question. Instead:

- **Attribution.** The question goes into the destination's relay with `remoteDeviceId` and `remoteDeviceName` in
  `ElicitationContext`/`PendingElicitation`. Every surface that lists the question shows where it came from: the
  control socket `confirmations.list` and the phone route below.
- **Phone route.** `GET /v1/printer-handoff/elicitations` and `…/:id/respond` (scope `printer-handoff:use`, which phones
  hold) also list and answer remote-tagged questions from every destination's relay, not just `current`.
- **No self-answer.** The respond route gets the answering device id from `authorize`, and refuses an answer from the
  device that asked.
- **No relay scope for remote devices.** `pair-mcp` never grants `printer-handoff:use`.

**Not in this change:** a phone or Mac screen that draws these questions. ObjectService shows only questions tied to a
project, and no Mac view calls `confirmations.list`. So by default (`questionMs: 0`) a remote question is answered
`cancel` **at once**.
- **Why at once:** waiting out the 600 s relay timeout would only hold the session's mutex, and the owner's Pause and
  Stop (`session.exclusive`) wait on that mutex with no limit.
- **What always cancels:** remote `clear_hms_errors`, an unverifiable `resume_print`, and any print or heat the MCP is
  set to confirm.
- **When a screen ships,** raise `questionMs`. The routes and tags above are already in place for it.

This is open question 2.

## Serialization

1. **Gate first.** Every call above `read` (`design`, `control`, `print`, `raw`) first takes
   `PrintGate.hold(destinationId)`, as the app's design passes and phone prints do (PRD §8.10), and holds it until the
   call ends. It never waits: while an update runs it throws "printer updating".
2. **Then the mutex.** Every remote `tools/call` runs under the session mutex (`exclusive: true`), tagged with its
   remote context. Otherwise a remote "read" tool that asked a question while the app's print held the mutex would
   carry that print's `bundleId`. ObjectService would then show it on the project, and David would approve a request
   he didn't make.
3. **Bounded wait.** The mutex wait is limited to 30 s. A remote call that can't get the mutex gets "printer busy" and
   holds nothing.
4. **Calls run to completion.** The client's HTTP disconnect does not abort a dispatched call, so the shared session is
   never quarantined because a remote socket closed.
5. **A remote call is limited to 120 s.** A call that overruns ends its connection, as any abandoned call does, so it
   can't keep asking. The next call reconnects.
6. **Prompts and resources take the mutex too.** Remote `prompts/*` and `resources/*` also run under the mutex, with the
   same wait limit, the same 120 s limit and the device's tag. A JSON-RPC error that the upstream answered (an unknown
   prompt, a failed read) is returned as it is and never ends the shared session. Only a timeout, abort or lost
   connection does that. A question an upstream prompt asks is therefore the device's own, and is
   cancelled like any other.

**Known limit:** the app's own unexclusive reads (no context) can still raise an untagged question. That question
fails closed: no surface ties it to a project.

## Pairing

```
remote-auth-cli.js pair-mcp <directory> [login] <scope>...
```

- Scopes come from `read design control print raw`. `read` is always added, and `printer-handoff:use` is never
  granted.
- The command mints the usual one-time, five-minute invitation. The client exchanges it at `POST /v1/pair`.
- `devices` and `revoke` work as today.

## Tests (`services/companion/tests/remote-mcp.test.mjs`)

The tests use the SDK's `StreamableHTTPClientTransport` against `startCompanionServer` on loopback, with a fake stdio
MCP. The fake has declared, undeclared, raw and eliciting tools, a prompt and a resource. They cover:

- **Authentication:** no token, wrong login, a revoked token and a missing `mcp:read` scope are refused. A token revoked
  while its call is queued doesn't dispatch.
- **Scopes:** `tools/list` is filtered, and calls outside scope are refused. An undeclared tool and a raw tool are off
  without `mcp:raw`. An annotation never sets a class; the declaration does.
- **Arguments:** refused keys are refused (`host`, `route`, `bridge_command`), along with relative paths, `..`, a `;`
  list escape, an embedded path in text, a symlinked final component, and a `design` write outside the device folder.
- **Confirmations:** a question is tagged with the device, the asking device can't answer it, and a phone's answer
  reaches the MCP. A question raised while the app holds the mutex waits rather than borrowing the app's tag.
- **Passthrough:** tools, prompts and resources pass through unchanged, and a template-style URI is refused.
- **Concurrency:** the mutex wait is bounded, and a client disconnect doesn't quarantine the session.
- **Routing:** a non-`current` destination is reachable, and an unknown destination returns 404.

## Open questions for David

1. **Network path (blocks real use).** Tailscale isn't installed on the Mac, and the companion runs LAN-only. Pick one:
   - Serve mode;
   - a subnet route;
   - a certificate that names the tailnet address.

   See Front door.
2. **A phone (and Mac) screen** for printer questions not tied to a project, showing the asking device's name. Until it
   exists, remote questions are cancelled at once.
3. **Should remote prints always ask on the phone,** even though Counterpart's own prints don't? That would be a new
   rule, so it isn't added.
4. **Getting a model into a device's folder** from a cloud session (an upload route) isn't built.
