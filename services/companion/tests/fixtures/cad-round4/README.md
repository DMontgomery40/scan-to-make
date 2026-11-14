Round-4 `cad-result.json` receipts (engine round 4, #608; bambu-printer-mcp and mcp-3D-printer-server
`feat/engine-round-4`), key for key: the cad/1 receipt the Forester mount pass wrote on Nov 10, plus what round 4
adds from `src/cad-engine.ts` (`final_requested`, `final_refused`, `next`) and `src/cad/purpose.py`
(`purpose.requirements[]`, `purpose.blocked`, `ready`, `renders.use`), with the requirement wording those files write.
`@RUN@` is the run folder; the tests put the real one in.

- `final-refused.cad-result.json`: the worker asked for `final: true` and the engine refused it.
- `not-ready.cad-result.json`: a run the worker never asked to make final; its purpose checks still fail.
