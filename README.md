# Scan to Make

An open-source consumer app for making useful things that fit the objects and spaces around you.

This sister repository is separate from the Bambu printer MCP. The first agreed slice is a cup-holder adapter: captured reference and confirmed dimensions, editable preview, a scoped fit coupon, and independently checked export or companion printing. The shared mobile shell starts with a real React Native/native-capture spike; the result decides. Local repeatable workers precede hosted deployment.

Team conversation uses real Slack: [build room](https://app.slack.com/client/T0C92NRJM5G/C0C8WNMEKAP), [decisions](https://app.slack.com/client/T0C92NRJM5G/C0C96L9JC76), and the append-only [scratchpad](https://app.slack.com/client/T0C92NRJM5G/C0C8MHYGZHD). Access requires membership in the team workspace.

The current repository is a project bootstrap, not an implemented application. Research and local archival mirrors remain under `docs/research/` and `shared/`; actual runtime/device evidence is recorded separately. The product remains open source; software licences and distribution rights will be recorded before shipping code that depends on them.

## Self-host (offline tools)

From a clean clone, one command bootstraps a `usd-core` 26.8 venv and runs the tests and synthetic repros for `tools/capture-mesh-convert`, `tools/capture-fit-eval` and `tools/capture-pipeline` (pipeline and duplicate):

```sh
git clone https://github.com/DMontgomery40/scan-to-make && cd scan-to-make
tools/self-host-smoke/smoke.sh
```

It prints a PASS/FAIL summary and exits nonzero on any failure. The capture-import/native end-to-end gate is **still open**: it isn't exercised and is reported as `OPEN` until the import seam lands. See [`tools/self-host-smoke/README.md`](tools/self-host-smoke/README.md).
