# Self-host smoke

`smoke.sh` takes a clean checkout and, in one command, bootstraps the dependencies and smoke-tests the offline capture tools:

```sh
tools/self-host-smoke/smoke.sh
```

## Steps

1. Creates or reuses a venv with `usd-core==26.8`.
   - Default location: `${XDG_CACHE_HOME:-~/.cache}/scan-to-make/usd-core-26.8-venv`, outside the repo.
   - Override with `SMOKE_VENV=...`.
   - `SMOKE_SKIP_INSTALL=1` reuses an existing venv without running pip.
   - `PYTHON=...` picks the bootstrap interpreter, which must be 3.10 or newer.
2. Runs the unit tests:
   - `tools/capture-mesh-convert`
   - `tools/capture-fit-eval` (stdlib `python3`)
   - `tools/capture-pipeline` (pipeline and duplicate)
3. Builds the converter's synthetic fixtures, then runs the synthetic repros: `capture-pipeline/repro.py` and `capture-pipeline/duplicate_repro.py`.
4. Prints a PASS/FAIL line for each step and writes logs to a temp directory.

The script exits 0 only if every step passes.

## Not covered (gate stays OPEN)

The capture-import/native end-to-end gate is **not** exercised. It waits on the capture-import seam, and the script always prints it as `OPEN`. A passing smoke run means the offline tools work on synthetic fixtures. It does not mean device capture, import, or physical fit has been validated.

## Requirements

- `python3` 3.10 or newer, with `venv`.
- Network access to PyPI on the first run, for `usd-core`.
- No credentials, services, or devices.
