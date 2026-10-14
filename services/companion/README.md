# Companion preparation and intent journal

First increment of PRINT-001. This library stages exact file bytes, binds a draft print plan to the current accepted design, and keeps a durable once-only intention journal. It has **no MCP client, network listener, upload, print, heating or motion operation**. Creating an intent does not authorize physical dispatch.

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/project --ignore-scripts
npm ci --prefix services/companion --ignore-scripts
npm test --prefix services/companion
```

Construct `new CompanionJournal(privateDirectory, projectStore)` in a trusted local companion. `stageArtifact(sourcePath, expectedArtifactRef)` copies a regular file into a unique private snapshot, verifies SHA-256 and byte length, and seals the snapshot read-only. Metadata is private; callers receive an ID and artifact identity, never a writable source location. Source changes do not alter the snapshot. Staging also accepts synthetic/nonprintable bytes: integrity is not geometry or G-code inspection.

`createPlan({projectId, snapshotId, selection})` requires the current accepted project revision and verifies the snapshot again. The plan records the accepted design identity separately from the proposed printable artifact. It includes printer ID/model, selected plate, complete declared nozzle diameters, material/tray positions, bed and settings digest. Its digest binds every field. Model names, physical tray ranges and complete filament coverage still require validation against the actual discovered MCP schema and inspected selected plate; merely storing them does not establish support. Printer IDs must come from a trusted pairing registry with one stable ID per actual printer; callers cannot choose aliases to evade the journal.

`beginAttempt(plan, approval)` rechecks the plan digest, current accepted design/revision and exact staged bytes, then flushes one intention record before returning. Approval records must name that exact plan, identify an actor, explicitly confirm, and expire within five minutes according to the companion's clock. These fields represent an authenticated human decision supplied by the caller; a model-supplied `confirmed: true` is not authorization. This method does not call a printer and does not freeze project edits. The later executor must recheck project/approval freshness and printer state after any human response and immediately before dispatch.

One unreconciled attempt blocks the printer, including a recorded `started`, `unconfirmed` or `uncertain` outcome. A new service instance reads the same history and cannot replay the old plan. `recordOutcome(printerId, attemptId, {state})` appends the observed backend classification once. Unknown responses, disconnects, crashes and generic errors must be classified as uncertain; an error is not evidence of rejection. `started` is a dispatch receipt, not physical-print or fit verification.

`reconcile(printerId, attemptId, {actorId, confirmed: true, resolution})` records an explicit operator decision (`finished`, `cancelled`, `rejected`) after checking the actual job. It preserves every original event. The old plan still cannot be retried; a new plan and fresh human approval are required. Callers authenticate the operator and verify the job evidence. Reconciliation is not automatic and cannot be delegated to a model's guess.

Files and directories use private permissions. Per-printer filesystem locks serialize readers/writers across instances; the JSONL journal is append-only and every event is flushed. Malformed history or an interrupted lock fails visibly. An operator must verify that no writer remains and inspect the actual printer/job and journal before recovering a lock. No automatic lock expiry, replay or power-loss guarantee is supplied. Use a local filesystem supporting the file/locking operations.

## Remaining integration gates

The existing `bambu-printer-mcp` remains a separate process. Its actual public `print_3mf` schema uses `three_mf_path`, `bambu_model`, `plate_index`, full `nozzle_diameters`, `use_ams`/`ams_slots` and model-specific `connection_mode`. The companion must discover/validate that schema instead of exposing arbitrary bridge methods or executable overrides. This package does not translate or send those arguments yet.

Before enabling a print/export route, integrate authenticated pairing/project access, genuine geometry and slicer provenance tying these two artifact identities together, prepared-file/selected-plate inspection, discovered model/route support, exact model/nozzle/material/AMS checks, fresh observed identity/ready/error state, human elicitation and once-only dispatch through the existing MCP gate. Unsliced input must not silently change approved bytes through auto-slicing. Checked export is not implemented in this increment. Stop/cancel/heater-off in the existing MCP remain available independently of this journal and any future billing/design service.

Source baseline for protocol facts: `bambu-printer-mcp` 1.1.26, `src/index.ts` public `print_3mf` schema/handler and response handling; `src/printers/bambu.ts` returns `dispatch: started | unconfirmed`. No implementation code was copied or imported from that GPL server.
