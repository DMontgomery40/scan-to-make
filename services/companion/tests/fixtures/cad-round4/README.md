Round-4 `cad-result.json` receipts (engine round 4, #608; bambu-printer-mcp #160 and mcp-3D-printer-server #116,
`feat/engine-round-4`). `@RUN@` is the run folder; the tests put the real one in and write every file the receipt
names at that path.

- `not-ready.cad-result.json`: **real.** A run the worker never asked to make final, from the round-4 Sonnet re-run of
  Nov 14 (case `r5-A2`, the Forester phone holder: its fourth of nine `cad_run`s, `chk_cradle_seated`). It is the
  `cad_run` tool result from that case's `stream.jsonl`, which is the run's `cad-result.json` key for key (checked
  against the last run's receipt on disk). Only the run folder's path is replaced by `@RUN@`; nothing else is changed.
  It is valid, not `ready`, and one purpose requirement (`use is the built part`) fails with its `fix`. The receipts are
  kept on the Mac in `~/scan-to-make-work/round4-receipts-2026-11-14/`.
- `final-refused.cad-result.json`: **synthetic.** The worker asked for `final: true` and the engine refused it. The re-run
  had no refusal, so no real one exists. Its values are the Forester mount's, written from round 4's `src/cad-engine.ts`
  (`final_requested: true`, `final_refused` = `purpose.blocked`, the refusal's `next`) and `src/cad/purpose.py`. Its keys,
  their order and every key the engine always writes (`bodies`, `checked`, `not_checked`, `problems`, `printed`,
  `checks.step_solids`, `purpose.within_deg`) follow the real receipt above.

What the real receipts showed (Nov 14): `final_requested` and `final_refused` appear only on a refusal; requirement
statuses are `pass`, `fail` and `not_modelled`, with `fix` only on the ones that didn't pass; `stl`, `script`,
`parameters`, `step`, `input_manifest`, `result_manifest` and every render are absolute paths inside the run folder.
