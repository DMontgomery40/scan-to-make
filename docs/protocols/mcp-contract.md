# The MCP surface Counterpart consumes

Every MCP name that app code (`services/companion/src`, `services/printer-handoff/src`) writes or reads, plus the `counterpart/1` result fields. The app is a front end stapled onto the printer MCPs (PRD §8.0). This list is the seam.

`services/companion/tests/mcp-contract.test.mjs` reads the sources' TypeScript AST and fails when this file and the code disagree, in either direction. It reads every snake_case string and key, and every key of an object literal that has a snake_case key (an MCP argument or result shape). Adding a tool, argument or result field to app code forces an edit here. Before adding one, ask whether it belongs in the MCPs instead. Names tagged **§8.0 #n** are in the app today and are moving to the MCPs.

## Tools

| Names | Used for |
|---|---|
| `counterpart_printer_info` `counterpart_print_progress` `counterpart_print_route` `counterpart_make_3mf` | the `counterpart/1` contract (PRD §8.4) |
| `get_printer_status` `get_printer_filaments` | spools, and Add Printer's connection check (`printing/setup.ts`, `printer-check.ts`); printer reports come only from `counterpart_print_progress`, never `get_printer_status` |
| `counterpart_propose_filaments` | which loaded spool prints each of a model's colours, before slicing, in the MCP's words (each spool's `label` and `name`, each part's `verdict` and `note`); with the person's `chosen` spools, the MCP checks them against what is loaded now and returns the full `mapping`. The app renders it and turns `mapping` into `ams_mapping`, `load_filaments` and `filament_colours`; it keeps no colour matching (**§8.0 #7**, moved) |
| `counterpart_setup_fields` `counterpart_discover_printers` | Add printer…: the printer kinds each MCP drives (with the `default` kind it runs when a `.env` sets no `PRINTER_TYPE`) and the `.env` settings it reads for each (with its model choices, the model each serial prefix names, and the slicer it would run), and the printers it finds on the network itself. The app renders those fields and writes the values under the MCP's own names; it keeps no printer, model or slicer tables (**§8.0 #6**, moved) |
| `slice_stl` `inspect_print_file` `get_slice_settings` `lay_flat` `get_stl_info` `rotate_stl` `scale_stl` | slicing and model files |
| `list_3mf_plates` | a designer's 3MF plates as Bambu Studio shows them before slicing (bambu-printer-mcp 1.1.69+, mcp-3d-printer-server 1.2.49+): each plate's index, name, objects, whether it is already sliced, and its picture. The app keeps them on the file's receipt and offers them in the plate list; it reads no plate metadata itself (PRD §8.0 #9). Each plate's `filaments` (bambu-printer-mcp 1.1.73+, mcp-3d-printer-server 1.2.53+) are the only colour rows the Print sheet offers for that plate, and `project_filaments` sizes `load_filaments`/`ams_mapping` (one entry per declared filament, -1 in `ams_mapping` where the plate prints nothing); which filaments a plate prints is the MCP's to work out, as Bambu Studio does (PRD §8.0 #7). An MCP without the tool, or without `filaments`, is one to update |
| `print_3mf` `print_3mf_bambu_network` `process_and_print_stl` `upload_gcode` `upload_file` `start_print` `start_print_job` `confirm_temperatures` `delete_printer_file` | dispatch |
| `pause_print` `resume_print` `cancel_print` `clear_hms_errors` `skip_objects` `set_fan_speed` `set_light` `set_print_speed` `set_printer_temperature` `set_temperature` | printer controls |
| `camera_snapshot` `camera_stream_start` `camera_frame` `camera_stream_stop` | printer camera |
| `bambu_network_bridge_status` | Bambu network bridge readiness (setup) |
| `blender_mcp_status` `blender_mcp_call` `execute_blender_code` `get_addon_status` | the Blender bridge |
| `fusion_mcp_status` `fusion_mcp_call` `fusion_mcp_new_design` `fusion_mcp_export` | the Fusion bridge |
| `blender_mcp_setup` | the Blender add-on's check and update (`update`), done by the MCP (moved, **§8.0 #11**) |
| `fusion_mcp_setup` | the Mac's Design with Fusion: the MCP finds Fusion and installs the add-in, its port login item and its own settings (`install`); the companion passes its result to the Mac as it is (moved, **§8.0 #11**) |
| `fdm_design` `fdm_slicing` | the MCPs' design prompts, added to every design pass as served: how to design for FDM, and how the configured slicer orients a model, generates supports and checks a choice with a checkpoint slice. The app's own rules name no slicer (PRD §8.0 #10, moved) |

## Tool arguments

| Names | Where |
|---|---|
| `slice_plate` `plate_index` `three_mf_path` `file_path` `gcode_path` `stl_path` `template_name` `ensure_on_bed` `extension_inches` | slicing and dispatch paths |
| `orient` `arrange` `repetitions` `print` `filename` `material` `timelapse` | slicing and dispatch options |
| `host` `port` `type` | the printer target (`type` is the printer type; model-API messages use the same key) |
| `quality` `strength` | the print sheet's choice, passed as chosen; the MCP picks its slicer's numbers |
| `layer_height` `wall_loops` `sparse_infill_density` | a printer config's own explicit values, passed through |
| `enable_support` `support_type` `pause_at_layers` `load_filaments` `filament_profile` `filament_colours` `slicer_profile` `slicer_type` `nozzle_diameter` `nozzle_diameters` `nozzle_type` `bambu_model` | slicer choices; which slicer accepts which is decided in the app, **§8.0 #3** |
| `use_ams` `ams_slots` `ams_mapping` `auto_match_ams` `use_printer_filaments` | AMS mapping (proposal moving, **§8.0 #7**) |
| `bed_leveling` `bed_type` `flow_calibration` `layer_inspect` `vibration_calibration` | `print_3mf` start options |
| `bambu_network` `bambu_connect` | Bambu connection modes |
| `hardened_steel` `stainless_steel` `tungsten_carbide` | nozzle materials known to the app, **§8.0 #6** |
| `timeout_ms` `max_bytes` `max_width` `min_change` `changed_only` `idle_timeout_ms` `since_seq` `wait_ms` `fps` | camera |
| `duration_ms` | how long `counterpart_discover_printers` listens |
| `angle_x` `angle_y` `angle_z` `scale_x` `scale_y` `scale_z` | rotate and scale |
| `include_preview` `bed_side` | `inspect_print_file`'s preview of the exact sliced file: asked for with `include_preview`; the `top` and `bed_side` views are shown as they are. The app checks its `artifact_sha256` against the file and the PNG signature, never the G-code |
| `slicer_report` `slicer_message` `plate_count` `layer_height_mm` `sparse_infill_percent` `wall_loops` `layer_count` `slicer_result` | what the app reads about a slice, all from the MCP (bambu-printer-mcp 1.1.64+, mcp-3d-printer-server 1.2.42+; §8.0 #8, #9): a slicing result's `slicer_report` (`failed`, `message`, `plate_count`, and `slicer_message`, the slicer's own words, which the companion writes to its log on a refusal and never shows; a result with `slicer_result` and no `slicer_report` is an MCP to update) and `inspect_print_file`'s `sliced` (`plate_count`, `estimate` `seconds`/`grams`, `settings`). The app keeps no slice cache: the MCPs reuse identical slices |
| `include_thumbnails` `thumbnail_png_base64` | `list_3mf_plates`' argument and each plate's picture, saved as the plate's render |
| `project_filaments` `filament_id` | `list_3mf_plates`' every declared filament, and each filament's Bambu filament id (with `index`, `colour`, `material`, `name`), read field by field in `model-plates.ts` |
| `source_path` `raw_key_count` | `get_slice_settings`'s argument and the result field compared, with `summary`, between a designer's 3MF and a copy's edit of it: the app checks the two reports match, never what's in them |
| `own_process` | `get_slice_settings`' answer that a 3MF prints with the process it carries (a designer's project), unchanged. It is asked with the printer config's own slice arguments, passed as `slice_stl` gets them (`slicer_type`, `bambu_model`, `slicer_profile`, `template_name`, `layer_height`, `wall_loops`, `sparse_infill_density`, `quality`, `strength`); the MCP decides which of them replace or change the file's process. The print sheet then starts at the file's own settings. An MCP that can't take one of those arguments, or doesn't say, leaves it unknown |
| `tool_name` `user_prompt` `arguments` `code` | `blender_mcp_call` |
| `launch` | `fusion_mcp_status` |
| `get_parameters` | the Fusion add-in's read of the open design's parameters, called through `fusion_mcp_call` by the companion's `fusion.status` only when the MCP doesn't report `activeDesign`. Interim (§8.9): deleted once both MCPs report `activeDesign` and it is installed through Update |
| `document_id` `source_f3d` `bind_document` `close_document` `document_binding` | Fusion document binding |
| `addon_version` `after_install` `blender_version` `protocol_version` `expected_protocol_version` `up_to_date` | the running Blender add-on's `get_addon_status`, read before a cleanup pass and inside `blender_mcp_setup`'s `live` |
| `expected_protocol` `live_error` `target_problem` | `blender_mcp_setup`'s result, with `supported`, `reason`, `listening`, `live`, `target`, `current`, `replaced` and `message`: the app shows the MCP's `message` as it is when it can't check or update the add-on, derives its Settings states from the booleans, and keeps the print gate and the helper lock |

## Remote devices (`/v1/mcp`)

Which tools a paired device may call, and which of their arguments it may set, come from each tool's `_meta["counterpart/remote"]` (bambu-printer-mcp 1.1.64+, mcp-3d-printer-server 1.2.42+): `scope` (`read` < `design` < `control` < `print` < `raw`), `raisedBy` (a true argument that needs a higher scope) and `arguments` (`config` and `config-top`: the destination's configuration chooses it; `path`, `output`: a file read or written). `services/printer-handoff/src/remote-mcp.ts` keeps no tool or argument names: a tool without a declaration is `raw`. Prompt arguments get the generic check only (no path-looking values outside path arguments).

## File metadata the app parses

| Names | Where |
|---|---|
| `bbox_objects` `wipe_tower` | 3MF/G-code metadata read in `model-file.ts`, **§8.0 #9**. The app no longer reads any project filament metadata: a plate's filaments come from `list_3mf_plates` (**§8.0 #7**) |

## counterpart/1 result fields

Keys of the `z.object` schemas in `services/printer-handoff/src/counterpart.ts`.

| Names |
|---|
| `contract` `server` `name` `version` `printer` `kind` `model` `serial` `host` `id` `capabilities` `progress` `layers` `camera` `cameraStream` `filaments` `pause` `resume` `cancel` `print3mf` `gcode` `slicing` `supports` `copies` `orient` `controls` `route` `mode` `choices` `options` `label` `available` `reason` `type` `url` `savedTo` |
| `observedAt` `state` `job` `elapsedSec` `remainingSec` `layer` `totalLayers` `stage` `temps` `nozzle` `bed` `chamber` `actual` `target` `activeFilament` `slot` `material` `color` `problems` `code` `severity` `message` |

## Not MCP

Snake_case names the same sources use for something else.

| Names | What |
|---|---|
| `agent_message` `command_execution` `mcp_tool_call` `response_item` `turn_context` `structured_output` `tool_use` `tool_use_id` `tool_result` `tool_call_id` `is_error` `total_cost_usd` `session_id` `input_schema` `max_tokens` `media_type` `image_url` `fetch_url` `read_file` `view_image` `web_search` `messages` `role` `content` `system` `tools` `model` `name` `description` `data` `result` | Claude Code, Codex and model-API stream, message and tool shapes |
| `needs_closeup` `needs_file` `scale_to_reference` `target_mm` | the design pass's own outcome and the app's scan cleanup |
| `not_signed_in` `download_not_saved` `site_error` `not_found` | why the published-model worker didn't get the designer's file (PRD §8.11) |
| `mcp_servers` `authorized_keys` `node_modules` | config files and install folders |
