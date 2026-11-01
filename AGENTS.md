# Scan to Make

Build an open-source iPhone app that scans a real object with LiDAR and cleans up the scan's defects. David, 2026-10-31: "this app is so you can scan an object USING LIDAR on iphone. and then smooth out defects and such. but really anything after that is already built and downloaded by 10k people a month and it's my bambu mcp. later we may add mcp 3d printer. actually, may as well just have that be an option from the get go."

The app covers capture (LiDAR Object Capture plus close-up stills) and cleanup (`tools/scan-repair`, `tools/scan-correct`, `tools/capture-mesh-convert`, run by the companion). The clean mesh then goes to [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) (`/Users/davidmontgomery/mcp-3D-printer-server` on the Mac). The handoff is built: the companion relays it through `services/printer-handoff` (#124), and the phone's Send to printer flow answers the printer's questions (#132). The consumer journey and Mac app design are in [`docs/design/journey.md`](docs/design/journey.md).

## Read bambu-printer-mcp before you build

`bambu-printer-mcp` ([GitHub](https://github.com/DMontgomery40/bambu-printer-mcp), `/Users/davidmontgomery/bambu-printer-mcp` on the Mac) is most of this product's working back end, not a side adapter. It already has:

- slicing with exact machine presets, bed and nozzle types, auto-orient and sliced 3MF export (`slice_stl`, `slice_with_template`, `get_slice_settings`);
- print-file inspection, the print safety core and AMS mapping (`inspect_print_file`, `src/safety/`, `resolve_3mf_ams_slots`);
- mesh edits (`lay_flat`, `rotate_stl`, `scale_stl`, `center_model`, `extend_stl_base`, `merge_vertices`, `get_stl_info`) and Blender MCP (`blender_mcp_edit_model`);
- every print route: direct LAN, the FULU `bambu_network` bridge (signed commands, no Developer Mode), X2D `bambu_native` and the Bambu Connect hand-off;
- the Made to Fit PRD and cost model in `docs/prd/`, covering pricing, licensing, hosting, print routes and the design runtime. It is one of three source plans (with Codex's `docs/research/PRD.md` and Muse's `shared/plans/muse.md`, both private on the Mac; index in `shared/PLANS.md`). What the team accepted is in Slack #decisions (D001–D004 and later) and `shared/team/DECISIONS.md`; where a plan and an accepted decision differ, the decision wins.

Rules:

- Before you build, plan, delegate or ask David about anything that touches printing, slicing, orientation, mesh editing, print safety, pricing, hosting or licensing, read the matching part of that repo (README, `docs/`, `docs/prd/scan-to-print-PRD.md`, its AGENTS.md) and the accepted decisions, plus its agent memory on the Mac (`~/.claude/projects/-Users-davidmontgomery-bambu-printer-mcp/memory/`). Search its session logs there too. Restore missing logs from Time Machine (SSH lacks Full Disk Access; run a `.command` script with `open -a Terminal`).
- If it has the capability, call it through MCP. Don't reimplement it here. bambu-printer-mcp is the slicing and printing back end, and agents may call any of its tools, including the ones that talk to the printer (status, camera, upload, `print_3mf`). Starting a physical print keeps bambu-printer-mcp's own human confirmation.
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

## Local PR checks

Before pushing, run `scripts/ci-local.sh all --changed-only` and the local reviews described in [scripts/README.md](scripts/README.md). Paste the command/result summary into the PR and its KAN ticket. The workflow YAML is the test source of truth; the guide explains local runtime selection and Mac launchd execution. This is David's local-gate process from 2026-10-31 (KAN-181).
