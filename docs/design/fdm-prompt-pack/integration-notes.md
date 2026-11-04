# Integration with David's MCP servers

Read-only inspection, 3 November 2026. This package does not change either repository.

The audit examined these `main` snapshots:

- `DMontgomery40/bambu-printer-mcp`: `849ad7fcee8723689015945a9a40bb60d4928341`.
- `DMontgomery40/mcp-3D-printer-server`: `5cdee768467b906a7d695f6a8a92462a92a2daf1`.

## Use the existing design and slicing tools

The Bambu server already supplies the useful connections. The prompt layer can sit in the frontend that orchestrates them.

| Existing tool | Role in the prompt workflow |
| --- | --- |
| `get_printer_filaments` | Provides live AMS/external inventory, loaded/empty slots, profile matches, confidence, and recommended filament-profile paths when model context is known. |
| `get_slice_settings` | Reads a file/template's slicing settings. Use effective resolved profiles where needed; a partial project override is not the complete process. |
| `blender_mcp_status`, `blender_mcp_call` | Discover and invoke the connected Blender tool surface. Preserve scale and critical surfaces when touching up a scan. |
| `fusion_mcp_status`, `fusion_mcp_call` | Discover and invoke the actual connected Fusion operations. |
| `fusion_mcp_export` | Exports a body STL together with the editable `.f3d` design and parameter JSON. Preserve the editable source for revisions. |
| `counterpart_make_3mf` | Combines separately exported STL bodies into an assembly with retained relative positions and explicit filament assignments. These bodies still need the correct print scheduling; separate color bodies do not imply separate color jobs. |
| `slice_stl` | Produces the actual sliced output. Run the post-slice review against this candidate. |
| `resolve_3mf_ams_slots` | Checks the sliced project's filament requirements against live AMS inventory without uploading or printing. |

All names above are existing Bambu tools in the inspected source, not newly proposed endpoints. Availability of downstream Blender/Fusion operations should still come from their discovery results.

## The important feedback detail

`slice_stl` returns the sliced file path in text and the slice result in `structuredContent`. When the slicer writes `result.json`, `structuredContent.slicer_result` carries that report verbatim. Its documented fields include `error_string`, `return_code`, and each `sliced_plates[].warning_message`, such as a floating cantilever warning. The general server also reads the CLI result as arbitrary JSON. [R1, R2]

Pass that structured report back to the agent. Do not feed it only the file path and a success flag.

The inspected implementation does not establish one stable normalized set of model/support/flush/tower grams, predicted duration, and change counts. A small version-aware adapter can extract whatever the installed slicer's report or sliced file actually supplies. Preserve source field names and units, retain the raw report, and use `null` or an explicit unavailable state for missing values. This adapter is a recommendation, not code implemented by this prompt package.

Keep each report associated with its exact model revision, plate, orientation, material assignments, and process profile. Compare the same requested quantity and finish. Do not calculate claimed savings using a stale slice or an invented material breakdown.

## Applying changes

Make design and process changes before slicing, then review the resulting toolpaths. The general server's slicing guide explicitly warns that several accepted `print_3mf` settings do not modify an already sliced file. Changing layer height or support behavior requires a new slice. [R3]

The existing prepared-file inspection and print preflight have separate purposes. They are not evidence that a bridge will have a smooth underside or that a fitted clamp has been physically tested. Keep the application's established print workflow; these prompts add manufacturing judgment before the final handoff.

## Sources

[R1] Bambu tool declarations and handlers at the inspected commit:

https://github.com/DMontgomery40/bambu-printer-mcp/blob/849ad7fcee8723689015945a9a40bb60d4928341/src/index.ts

[R2] General server CLI report handling at the inspected commit:

https://github.com/DMontgomery40/mcp-3D-printer-server/blob/5cdee768467b906a7d695f6a8a92462a92a2daf1/src/slicer/bambu-cli.ts

[R3] General server slicing guide:

https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md

Repository links:

https://github.com/DMontgomery40/bambu-printer-mcp

https://github.com/DMontgomery40/mcp-3D-printer-server
