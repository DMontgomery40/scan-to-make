# Blender addon repair — 2026-11-02

The installed bridge can discover tools while Blender runs an incompatible addon. Settings on Mac and
phone will share companion-owned status, Check Again and Update Add-on actions. Status checks the live
addon when available; a closed listener is not Ready. A successful file replacement in a running Blender remains restart-needed
until a fresh live handshake proves compatibility; a closed compatible install is set up for the next cleanup. The companion never starts or closes Blender for Settings.

The configured upstream package supplies inspection metadata and its official `install-addon` command.
Repair stages that installer into a private temporary directory, validates the bundled addon and protocol,
requires a durable exclusive backup, then atomically replaces only the existing validated module path.
It preserves a legacy `addon.py` name and never creates a second enabled alias. Existing helper and MCP
reservations exclude concurrent passes/updates. Both clients poll the same bounded repair operation.

Validation covers incompatible addons, no listener, failed backups, user-owned restart-needed sessions,
module-name preservation and transport/action parity. Printing owns the separate pass preflight and
idempotent startup fixes; this feature reuses its addon-status helper.

Implementation evidence before review: 39 focused repair/readiness tests pass, including old/closed addons,
failed backup, no duplicate legacy alias, HTTP read/write scope enforcement, and bounded lock cancellation.
The complete Node 24 suite on the merged readiness base passes 683 tests with 9 intentional skips. Shared Swift 138 and ControlKit 46 tests pass; both native apps compile.
A read-only run of the actual configured localhost-SSH resolver plus upstream inspector found the enabled
5.0 `addon.py` at protocol 15 and separately retained the older 4.4 copy. No addon was installed by this branch.

Spec and independent Standards review corrected view action replay, stopped-helper wording, per-attempt
repair results, and configuration resolution. Host-only Blender environment variables cannot select a bridge
that the printer MCP does not use. The configured compatibility alias is verified before staging its pinned dependency.

External PR review found a fresh service reporting checking without an operation. Initial status is now
nonbusy unchecked; direct status and authenticated HTTP regressions verify that reads do not invent work.
