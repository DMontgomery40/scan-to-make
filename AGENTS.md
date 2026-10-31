# Scan to Make

Build an open-source consumer app: scan objects and their surroundings, describe an addition, make something that fits, and print it. The hosted service supplies inference and compute; the same core remains self-hostable.

Use real Slack for conversation. Add informal findings to the append-only scratchpad channel; preserve linked dated/topic archives. `shared/SCRATCHPAD.md` is a local archival mirror.

Before choosing work, read recent Slack messages in [build-room](https://app.slack.com/client/T0C92NRJM5G/C0C8WNMEKAP), [decisions](https://app.slack.com/client/T0C92NRJM5G/C0C96L9JC76), and the append-only [scratchpad](https://app.slack.com/client/T0C92NRJM5G/C0C8MHYGZHD). Local shared files are plan/archive mirrors, not a fake chat system. User instructions outrank plans. Codex coordinates with one vote; two matching member votes carry, and three different choices go to David. Grok/Cursor together have one vote. Muse Wonder Full gets slight advisory preference only on common-sense judgments; regular Wonder or another model does not.

UI design, copy, components, interactions and visual implementation are authored by Claude Opus 5.5 until an explicitly qualified replacement is recorded. Other members can report defects and define data contracts; they hand UI fixes to the qualified UI author.

Claim a task and its file scope before editing. One owner per active scope. Preserve others' uncommitted work. Review observable defects and the agreed acceptance criteria; use one bounded review pass, then verify fixes. Keep speculative improvements in the backlog.

## Read bambu-printer-mcp before you build

`bambu-printer-mcp` ([GitHub](https://github.com/DMontgomery40/bambu-printer-mcp), `/Users/davidmontgomery/bambu-printer-mcp` on the Mac) is most of this product's working back end, not a side adapter. It already has:

- slicing with exact machine presets, bed and nozzle types, auto-orient and sliced 3MF export (`slice_stl`, `slice_with_template`, `get_slice_settings`);
- print-file inspection, the print safety core and AMS mapping (`inspect_print_file`, `src/safety/`, `resolve_3mf_ams_slots`);
- mesh edits (`lay_flat`, `rotate_stl`, `scale_stl`, `center_model`, `extend_stl_base`, `merge_vertices`, `get_stl_info`) and Blender MCP (`blender_mcp_edit_model`);
- every print route: direct LAN, the FULU `bambu_network` bridge (signed commands, no Developer Mode), X2D `bambu_native` and the Bambu Connect hand-off;
- the product plan: the Made to Fit PRD and cost model in `docs/prd/`, covering pricing, licensing, hosting, print routes and the design runtime.

Rules:

- Before you build, plan, delegate or ask David about anything that touches printing, slicing, orientation, mesh editing, print safety, pricing, hosting or licensing, read the matching part of that repo: README, `docs/`, `docs/prd/scan-to-print-PRD.md`, its AGENTS.md, and its agent memory on the Mac (`~/.claude/projects/-Users-davidmontgomery-bambu-printer-mcp/memory/`). Search its session logs there too. Restore missing logs from Time Machine (SSH lacks Full Disk Access; run a `.command` script with `open -a Terminal`).
- If it has the capability, call it through MCP. Don't reimplement it here. Preparation runs it as a separate process with no printer credentials (`PRINTER_HOST`, `BAMBU_SERIAL`, `BAMBU_TOKEN` absent) and an allowlist of file-only tools. Only the human-approved dispatch step uses a credentialed process.
- Every PR here that touches those areas names the bambu-printer-mcp capability it uses, or says why none fits. Reviewers reject a PR that duplicates one.
- Never record that something is missing, wiped or needs a rebuild until you have checked that repo's memory, its session logs and the backups.
- Treat "separate" as "don't edit it casually". It never means "don't read it". Changes to it follow its own AGENTS.md safety and release rules. Additional printer adapters belong behind the product contract, never inside the Bambu-only fork.

Why this rule exists: on 2026-10-30 this repo's lead treated bambu-printer-mcp as a sealed driver and never read it. As a result:

- The repo gained a second BambuStudio slicing wrapper (`tools/slicer-producer`) and a printability dry-run slicer.
- Two PRs duplicated existing tools: an orientation picker (#94, a copy of `lay_flat`) and companion slicer overrides (#97).
- A working print harness was declared gone and replaced with a broken one.
- Questions the PRD already answers were sent to the owner to decide.

`slice_stl`, `lay_flat` and the harness were all documented beforehand. The owner had to find every one of these mistakes himself. The duplicates are being removed. Don't repeat this.

Hardware purchases and paid cloud deployments spend David's money: ask him first (kept pending his confirmation, 2026-10-31). Agents may use David's printer and phone for development and testing; bambu-printer-mcp keeps its own print confirmation.

Don't add restrictions David never gave. Before writing a rule into AGENTS.md, a brief, memory or docs, point to where he said it. If you can't, it isn't a rule.

Keep credentials, personal captures, private coordination and provider usage details out of Git. Never put agent attribution or session links in Git/GitHub commits, PRs or release notes. Shared local team records are private coordination, not public product documentation.
