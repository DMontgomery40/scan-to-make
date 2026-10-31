# Printer setup on the Mac

Printer setup uses the private [local control socket](local-control.md). Keys
are written by the Mac app into the login Keychain. The companion stores only
the choice and its Keychain reference in `auth/printer-setup.json` (0600).
Pairing and capture work without a printer.

| Method | Params | Result |
| --- | --- | --- |
| `printerSetup.get` | `{}` | `{revision, configured, choice, check, routes}` |
| `printerSetup.set` | `{expectedRevision, choice}` | New snapshot; stale revision or active print returns `conflict` |
| `printerSetup.check` | `{revision}` | Immediate snapshot; poll `get` until `check.state` finishes |
| `printerSetup.discover` | `{}` | `{state: "complete" \| "unavailable", printers}` after a bounded UDP 2021 scan |

`choice.kind` is `none`, `bambu`, or `other`. The Bambu fields mirror
[bambu-printer-mcp's manifest user_config](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/manifest.json):

| Backend field | Saved choice / handling |
| --- | --- |
| `printer_host` | Literal host; no URL, port suffix, credentials or path |
| `bambu_serial` | Printer serial |
| `bambu_model` | Supported model identifier |
| `bambu_token` | Keychain only, represented by a fresh UUID `keychainRef` |
| `slicer_path` | Optional absolute executable path |
| `blender_mcp_command` | Optional absolute executable path |
| `blender_mcp_args` | Optional JSON string containing an array of arguments |

The added `connection_mode` is `lan_mqtt_ftps`, `bambu_native`,
`bambu_network`, or `bambu_connect`. X2D uses the native route. Known P1
firmware before 01.08.05.00 is distinguished from its authorization-enabled
firmware; unknown telemetry stays unknown. These route hints do not authorize
printing. The backend's model, firmware and safety checks remain authoritative.

`other` uses `printer_host`, `printer_type` (octoprint, klipper, duet,
repetier, prusa, creality), optional `printer_port`, and `keychainRef` for
its API key. Optional `slicer_path` and `slicer_type` select its installed slicer; both are covered by the immutable Keychain binding. It calls mcp-3D-printer-server.

Discovery listens for bounded SSDP packets on UDP 2021, advertising an
M-SEARCH on active private IPv4 interfaces. Location must equal the packet's
private sender address. Discovery never fetches a URL or starts a printer
connection. Known model IDs come from Bambu Studio printer definitions;
unrecognized IDs require explicit model selection.

The Connected check calls `get_printer_status` and `camera_snapshot` through
MCP. Both must succeed for a Bambu printer. Other brands use their backend's
`get_printer_status` and report camera `not-supported`. No check calls print,
heat, motion, or settings tools. The JPEG is returned in memory on the local
socket; raw telemetry, backend errors and credentials are not returned.

FULU detection calls `bambu_network_bridge_status` in a separate session with
no printer key. A configured bridge must initialize its agent successfully
before the route is offered. This uses an already installed operator runtime;
it does not install or reconfigure a VM. The signed helper reads the optional
bridge command from its installed `companion.env`; socket callers cannot choose
that command. Printer keys are never written to that file.

## ControlKit binding

`PrinterSetupChoice`, `PrinterSetupSnapshot`, `PrinterSetupCheck`,
`PrinterDiscovery`, `PrinterRoute`, and `PrinterKeychain` are available to the
Mac UI. `ControlClient` exposes get/set/check/discover methods. No SwiftUI view
is provided by this module.

1. Construct a complete choice with a new UUID. Save the code with
   `PrinterKeychain.save(code, for: choice)` before sending the choice.
2. Call `setPrinterSetup(choice, expectedRevision:)`. Refresh on conflict.
3. Call `checkPrinterSetup(revision:)` and poll `printerSetup()` until the
   check is connected or failed. `snapshot.connected` checks the revision too.

Each immutable Keychain item binds the entire saved choice, including route
and executable settings. The helper refuses caller-supplied environment,
host, route, credentials and executable overrides. To change settings for the
same destination, use `PrinterKeychain.copyCredential(from:to:)` with a fresh
UUID, then save the new choice. Changing kind, host, model, serial, API type or
port requires entering its credential again. The copy method never exposes the
secret to the UI. Retain old references on unknown mutation outcomes and while
workers can still reference them; refresh state before removing unused items.

`none` implements **Set up a printer later**. It explicitly disables new
handoffs, cancels a pending check and keeps existing bundle data. Initial
`configured: false` preserves any legacy operator handoff configuration until
the app saves an explicit choice. Invalid preferences do not stop capture or
the paired phone API. Results and camera images do not persist across restart.

## Handoff integration

Saved choices select the existing `PrinterHandoffRunner`. The signed helper
resolves a fixed installed backend, reads the bound Keychain item, and execs a
stdio MCP proxy with the key only in its worker environment. The proxy permits
the existing handoff tool surface, forwards MCP discovery and human
elicitations, and injects the saved `connection_mode` into `print_3mf`. It
refuses arbitrary tools, destination changes and executable overrides. Raw
errors are sanitized and credential strings are removed from successful
responses as well. Slicing, mesh operations, print inspection, camera capture
and dispatch remain in the external backends, run unmodified as separate
processes (including the GPL backend and Blender).

Sliced and oriented artifacts are persisted into the bundle before dispatch and before the MCP session closes. Bambu Connect receives the durable bundle path, so asynchronous application launch cannot race temporary-file deletion.

A configuration lease prevents setup changes during an active handoff.
Bundles record `selection.setupRevision`; a changed setup requires a new
bundle, preventing an old confirmed job from silently changing printers.
Existing operator configuration remains usable until explicitly replaced.

Bambu Connect imports a file and does not start a print. Its successful bundle
state is `handed-off`, which is terminal and cannot be dispatched again.
Direct/native/FULU routes retain `printed`; uncertain dispatches retain
`uncertain`. Phone clients must recognize `handed-off` and direct the user to
finish in Bambu Connect. Print confirmation remains owned by the backend.

## Installed backends

This plumbing uses backends already installed by
`deploy/companion/install-macos.sh`, either under the app state root or the
retained legacy release's `printers/{bambu,generic}` prefixes. A missing backend
produces a failed connection check. The app does not fetch printer packages,
slicers, Blender, or a FULU runtime as part of this change. Their installer and
distribution remain separate from the setup model.
