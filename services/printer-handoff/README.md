# Printer handoff

Hands a cleaned scan from Scan to Make to a printer MCP server that already
knows how to orient, slice, inspect and print: either
[bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or
[mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server).
This package does not reimplement slicing or printer control.

## Pieces

- `HandoffBundleStore` — one directory per handoff under a bundle root:
  `clean.stl`, `designed.stl` once an agent has designed from it, recorded
  artifacts, and `handoff.json` with the prompt, chosen backend, optional
  selection, artifact digests and status. A desktop agent session claims a
  bundle locally; the companion prints from it afterwards (KAN-132).
- `PrinterMcpClient` — one stdio MCP session against the operator-configured
  server process. It discovers tools with pagination and bounds, validates
  call arguments against the discovered schemas (the two servers disagree on
  some argument shapes), and declares MCP elicitation support when a relay is
  supplied.
- `PrinterSession` / `PrinterSessionPool` — one long-lived MCP connection per
  printer destination (PRD §8.3), shared by every call to it. Holders keep it
  open; it closes 120 s after the last holder and call. A lost connection is
  reopened by the next call after a 1, 2, 5, 15 then 30 s backoff. Reads run
  concurrently; calls that change the printer or can ask a question
  (`MUTATING_TOOLS`, or any call given an elicitation context) take turns
  through a per-destination mutex, and only the mutex holder tags the
  server's questions. A runner without a session opens a one-shot session per
  operation, as before.
- `counterpart.ts` — zod schemas for the `counterpart/1` tools
  (`counterpart_printer_info`, `counterpart_print_progress`), the
  `get_printer_status` fallback for older installs, and capability detection
  with the "Update <MCP> to …" message.
- `InMemoryElicitationRelay` — turns each server elicitation into a pending
  confirmation with an id. `respond(id, answer)` answers it; a timeout
  resolves as `cancel`. Nothing is ever answered automatically.
- `PrinterHandoffRunner` — the print sequence:
  - bambu-printer-mcp: `lay_flat` → `slice_stl` → `inspect_print_file` →
    `camera_snapshot` → `print_3mf`.
  - mcp-3D-printer-server, G-code printers: `lay_flat` → `slice_stl` →
    `confirm_temperatures` → `upload_gcode` with `print: true`.
  - mcp-3D-printer-server, Bambu: `lay_flat` → `slice_stl` → `print_3mf`.
  - `processAndPrint` runs the generic server's one-call
    `process_and_print_stl` extend-and-print pipeline.

The Bambu camera snapshot, when available, is attached to the pending
confirmation so the phone prompt can show the bed before the user confirms.
The server still rechecks fresh printer state after the answer.

## Config

`readPrinterHandoffConfig(path)` reads one JSON operator config:

```json
{
  "backend": "bambu-printer-mcp",
  "process": {
    "command": "/usr/local/bin/node",
    "args": ["/Users/me/bambu-printer-mcp/dist/index.js"],
    "cwd": "/Users/me/bambu-printer-mcp",
    "env": {"SLICER_TYPE": "bambustudio", "SLICER_PATH": "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"}
  },
  "selection": {
    "model": "p1s", "nozzleDiameterMm": 0.4,
    "nozzleType": "hardened_steel", "bedType": "textured_plate",
    "material": "PLA", "plateIndex": 0
  }
}
```

Run the server by absolute path to its `dist/index.js`, as above. Printer
credentials stay in that MCP server's own environment configuration; they are
never part of a handoff bundle. For the generic server set
`"backend": "mcp-3d-printer-server"` and a `selection.printerType` such as
`klipper` or `bambu`.

## Tests

```sh
npm test --prefix services/printer-handoff
```

The default suite runs both sequences against fixture MCP servers that record
every call and elicit like the real servers.

Opt-in tests connect to real installed MCP server processes (skipped unless
enabled):

**bambu-printer-mcp** — discovery only; calls no tools:

```sh
PRINTER_HANDOFF_REAL_BAMBU=1 \
PRINTER_HANDOFF_BAMBU_ENTRY=/path/to/bambu-printer-mcp/dist/index.js \
node --test services/printer-handoff/tests/real-bambu.test.mjs
```

**mcp-3D-printer-server** — full `lay_flat` → `slice_stl` →
`confirm_temperatures` → `upload_gcode` flow against a loopback OctoPrint or
Moonraker stub and the real server process (slicing is stubbed in-process so
no slicer install is required):

```sh
PRINTER_HANDOFF_REAL_MCP_3D=1 \
PRINTER_HANDOFF_MCP_3D_ENTRY=/path/to/mcp-3D-printer-server/dist/index.js \
npm test --prefix services/printer-handoff -- tests/real-mcp-3d-printer-server.test.mjs
```

Optional: `PRINTER_HANDOFF_MCP_3D_ROOT` if `sample_cube.stl` is not under
the parent of `dist/`.
