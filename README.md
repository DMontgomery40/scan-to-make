# Scan to Make

An open-source consumer app for making useful things that fit the objects and spaces around you.

This sister repository is separate from the Bambu printer MCP. The first agreed slice is a cup-holder adapter: captured reference and confirmed dimensions, editable preview, a scoped fit coupon, and independently checked export or companion printing. The shared mobile shell starts with a real React Native/native-capture spike; the result decides. Local repeatable workers precede hosted deployment.

Team conversation uses real Slack: [build room](https://app.slack.com/client/T0C92NRJM5G/C0C8WNMEKAP), [decisions](https://app.slack.com/client/T0C92NRJM5G/C0C96L9JC76), and the append-only [scratchpad](https://app.slack.com/client/T0C92NRJM5G/C0C8MHYGZHD). Access requires membership in the team workspace.

The current repository is a project bootstrap, not an implemented application. Research and local archival mirrors remain under `docs/research/` and `shared/`; actual runtime/device evidence is recorded separately. The product remains open source; software licences and distribution rights will be recorded before shipping code that depends on them.

## Self-host

From a clean clone, two commands cover the offline tools and the authenticated portable-project/capture HTTP path. Both reuse a `usd-core` 26.8 venv (prefer `PYTHON=python3.12` when available). Native review/export acceptance stays **OPEN** in both summaries.

```sh
git clone https://github.com/DMontgomery40/scan-to-make && cd scan-to-make
tools/self-host-smoke/smoke.sh
tools/self-host-smoke/auth-smoke.sh
```

`smoke.sh` bootstraps the venv and runs the tests and synthetic repros for `tools/capture-mesh-convert`, `tools/capture-fit-eval` and `tools/capture-pipeline` (pipeline and duplicate). It does not start the companion listener.

`auth-smoke.sh` installs the checkout's companion/project/contracts packages, starts the authenticated generation/capture listener with isolated fixture auth only (no live tailnet or device changes), then exercises portable-project sync → real USDZ import → listener restart against the same storage → verified reopen and exact original download. Wrong-scope and stale `If-Match` requests must fail closed. The checkout is left clean (`git status --porcelain` empty).

Each command prints a PASS/FAIL summary and exits nonzero on any failure. A passing authenticated run is the HTTP path only; it does not claim native review, export, or physical-fit validation. See [`tools/self-host-smoke/README.md`](tools/self-host-smoke/README.md).
