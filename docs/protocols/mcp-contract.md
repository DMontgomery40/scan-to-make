# The MCP surface Counterpart consumes

Every MCP name that app code (`services/companion/src`, `services/printer-handoff/src`) writes or reads, plus the `counterpart/1` result fields. The app is a front end stapled onto the printer MCPs (PRD §8.0). This list is the seam.

`services/companion/tests/mcp-contract.test.mjs` reads the sources' TypeScript AST and fails when this file and the code disagree, in either direction. It reads every snake_case string and key, and every key of an object literal that has a snake_case key (an MCP argument or result shape). Adding a tool, argument or result field to app code forces an edit here. Before adding one, ask whether it belongs in the MCPs instead. Names tagged **§8.0 #n** are in the app today and are moving to the MCPs.

## Tools

| Names | Used for |
|---|---|
| `counterpart_printer_info` `counterpart_print_progress` `counterpart_print_route` `counterpart_make_3mf` | the `counterpart/1` contract (PRD §8.4) |
| `get_printer_status` `get_printer_filaments` | spools, and Add Printer's connection check (`printing/setup.ts`, `printer-check.ts`); printer reports come only from `counterpart_print_progress`, never `get_printer_status` |
| `slice_stl` `inspect_print_file` `get_slice_settings` `lay_flat` `get_stl_info` `rotate_stl` `scale_stl` | slicing and model files |
| `print_3mf` `print_3mf_bambu_network` `process_and_print_stl` `upload_gcode` `upload_file` `start_print` `start_print_job` `confirm_temperatures` `delete_printer_file` | dispatch |
| `pause_print` `resume_print` `cancel_print` `clear_hms_errors` `skip_objects` `set_fan_speed` `set_light` `set_print_speed` `set_printer_temperature` `set_temperature` | printer controls |
| `camera_snapshot` `camera_stream_start` `camera_frame` `camera_stream_stop` | printer camera |
| `bambu_network_bridge_status` | Bambu network bridge readiness (setup) |
| `blender_mcp_status` `blender_mcp_call` `execute_blender_code` `get_addon_status` | the Blender bridge |
| `fusion_mcp_status` `fusion_mcp_call` `fusion_mcp_new_design` `fusion_mcp_export` | the Fusion bridge |
| `fdm_design` | the MCPs' design prompt |

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
| `angle_x` `angle_y` `angle_z` `scale_x` `scale_y` `scale_z` | rotate and scale |
| `include_preview` `bed_side` | `inspect_print_file`'s preview of the exact sliced file: asked for with `include_preview`; the `top` and `bed_side` views are shown as they are. The app checks its `artifact_sha256` against the file and the PNG signature, never the G-code |
| `source_path` `raw_key_count` | `get_slice_settings`'s argument and the result field compared, with `summary`, between a designer's 3MF and a copy's edit of it: the app checks the two reports match, never what's in them |
| `tool_name` `user_prompt` `arguments` `code` | `blender_mcp_call` |
| `launch` | `fusion_mcp_status` |
| `document_id` `source_f3d` `bind_document` `close_document` `document_binding` | Fusion document binding |
| `addon_version` `after_install` `blender_version` `protocol_version` `expected_protocol_version` `up_to_date` | Blender add-on install and repair, **§8.0 #11** |
| `allow_mutating_method` `api_key` `bambu_network_method` `bambu_serial` `bambu_token` `bridge_command` `config_filename` `connection_mode` `connection_type` `country_code` `dev_id` `dev_ip` `extra_options` `ffmpeg_path` `plugin_dir` `runtime_dir` `save_template` `slicer_path` `template_dir` `use_ssl_for_ftp` `use_ssl_for_mqtt` `user_info` | arguments the remote-MCP scope table inspects, **§8.0 #5** |

## File metadata the app parses

| Names | Where |
|---|---|
| `bbox_objects` `filament_colour` `filament_diameter` `filament_ids` `filament_settings_id` `filament_type` `wipe_tower` | 3MF/G-code metadata read in `model-file.ts`, **§8.0 #9** |

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
| `agent_message` `command_execution` `mcp_tool_call` `response_item` `turn_context` `structured_output` `tool_use` `tool_use_id` `tool_result` `tool_call_id` `is_error` `total_cost_usd` `input_schema` `max_tokens` `media_type` `image_url` `fetch_url` `read_file` `view_image` `web_search` `messages` `role` `content` `system` `tools` `model` `name` `description` `data` `result` | Claude Code, Codex and model-API stream, message and tool shapes |
| `needs_closeup` `needs_file` `scale_to_reference` `target_mm` | the design pass's own outcome and the app's scan cleanup |
| `mcp_servers` `authorized_keys` `node_modules` | config files and install folders |
