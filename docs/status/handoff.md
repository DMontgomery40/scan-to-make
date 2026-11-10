# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md).

**How the owner works (David, Nov 6–9).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. Scanning by hand is physically hard for him: ask for one short, well-briefed scan, never repeated experiments, and treat the rig and the app-paced shutter as accessibility, not garnish. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

## Now (2026-11-10, 16:00Z)

**Lead:** Claude Fable 5.2, in the Mac mini's T3 environment (thread "Take Over Scan-to-Make Delivery"), since Nov 9 21:36Z. A second Fable session ("Find Implicit State Machines") builds the state-machine fixes and hands the lead pull requests.

**Every open item, its owner and its next step is in [`board.md`](board.md).** Read it after this page. Anything David says, and anything a report leaves undone, gets a row there in the same turn.

| Where | Installed |
|---|---|
| Mac, iPhone Davica3, iPad Air | **202611101110** from main `93006ec2` (the first three Nov 10 trains, #443, #456, #487). The fourth train (#499, main `9896c8f3`) merged at 15:57Z and its install on all three is running; the board's "Installed" line has the result. Receipts `~/scan-to-make-work/mac-202611101110/`, `iphone-202611101110/`, `ipad-202611101110/`. Mac rollback: `Counterpart-202611100845.app` in the Mac receipt folder. |
| Mac MCP copies | bambu-printer-mcp 1.1.84 and mcp-3d-printer-server 1.2.65, the newest of each (all ten MCP pull requests were published Nov 10; automatic updates are on). The code design engine is set up and ready. |
| Android, Linux (agents-136) | Nov 5 builds. Stale. |
| Public | Mac beta 6 and TestFlight 2.0 (4), both from `30e3afdd` (Nov 6). |

Printer: P1S, LAN Only + Developer Mode. David starts prints; the lead may start one when David has said the bed is clear (AGENTS.md). Nobody watches a print once it has started (David, Nov 10: "if a print starts, it's fine, and if it's not, it's a slicer issue, and we're not a slicer").

**What changed since #427** (all installed): worker rules per pass with "recognise and regularise" (#430); closed bottom after support removal (#434); pass limits and resume, the Nov 8 home and print UX, Live Activity identity and milestone alerts (#437); the companion uses the printer MCP's code engine for fit designs and scan cleanup when the MCP offers it (#439, inert until the MCPs are published and updated).

**How work lands** (operations.md): finished branches go on a train, with one review, one gate, and someone looking at the changed screens filled with real project data. The Mac has two build slots and one simulator session at a time (`scripts/lane.py`; every hold that boots a simulator is `--exclusive`); keep to about three heavy delegates.

**In motion** (detail and the rest on the board): the fourth train's install; the fifth train (#509 the third review's findings, #510 the screenshot tool's hardening, #513 one main action per page); real-data captures of every screen on iPhone, iPad and both Duo poses; Counterpart's own geometry kernel (round 3 on agents-136) and physics engine (round 3 on agents-173), in the private repo `DMontgomery40/counterpart-kernel`; the kernel's second test plate, which prints when David says the bed is clear.

Never-landed work is kept as tags: `git ls-remote --tags origin 'archive/*'`. Evidence and receipts: `~/scan-to-make-work/` on the Mac. Releases: [`../distribution.md`](../distribution.md).
