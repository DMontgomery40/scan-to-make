# Capture pipeline (offline, bounded)

`pipeline.py` runs one capture through the existing tools, as subprocesses, without changing either one:

1. **Input bounds.** These checks run before any parsing:
   - suffix must be `.usdz`, `.usdc`, `.usda` or `.usd`
   - byte size limit
   - for `.usdz`: entry-count limit, total uncompressed size limit, entries must be stored (not compressed), and no absolute, `..` or drive-letter entry names

   A violation gives `rejected-input` (exit 3), and the converter never runs.
2. **Preservation.** The original bytes are copied unchanged to `<work>/input/<sha256><suffix>`. The copy is re-hashed and checked against the input SHA-256.
3. **Conversion.** Runs `tools/capture-mesh-convert/convert.py` on the preserved copy. A nonzero converter exit, a missing report or `metricQualified != true` gives `rejected-conversion` (exit 4) **before evaluation**. The raw converter exit code, stdout, stderr and report are kept in the pipeline report. The converter's OBJ hash is re-checked.
4. **Units.** `declaredUnits` comes only from the converter's authored `metersPerUnit`, using an exact map: 0.001→mm, 0.01→cm, 0.0254→in, 1.0→m. Any other value gives `rejected-units` (exit 5) and is never rounded.
5. **Evaluation.** Runs `tools/capture-fit-eval/evaluate.py evaluate <obj> --units <declared> --held-out ... --json` in native scale mode. `pass-bounds-only` exits 0. Anything else gives `evaluation-failed` (exit 2), with the evaluator's exit code, stderr and JSON kept.

## Report

The report is deterministic JSON (`sort_keys`, 2-space indent, ASCII, no timestamps). Absolute paths are normalized to `<work>`, `<repo>` or `<input-dir>`.

Top-level keys are `schema`, `input`, `limits`, `heldOutDimensions`, `declaredUnits`, `converter`, `evaluator`, `rejection`, `verdict`, `exitCode`, and `provesCompleteCapture`/`provesPhysicalFit` (always `false`).

- `input` holds `fileName`, `byteLength`, `sha256`, the package entry names and counts, and `preservedPath`.
- `rejection` is `{verdict, reason, evidence}`. The evidence carries the raw converter exit code, stderr, `metricQualifiedReason` and `unsupportedFeatures`.

No geometry is rescaled, fitted or hole-filled. A pass is a bounds-only result, not proof of complete capture or physical fit.

## Usage

```sh
/workspace/usdz-venv/bin/python tools/capture-pipeline/pipeline.py capture.usdz \
  --held-out x=80 --held-out y=55 --held-out z=95 \
  --work-dir /tmp/capture-work --report capture-pipeline.json
```

- `--python` sets the interpreter used for the converter. It needs `usd-core` and defaults to the current interpreter.
- Limits: `--max-bytes` (default 256 MiB), `--max-entries` (256), `--max-uncompressed-bytes` (1 GiB).
- Exit codes: 0 pass-bounds-only, 2 evaluation-failed, 3 rejected-input, 4 rejected-conversion, 5 rejected-units.

## Synthetic repro (one command)

```sh
/workspace/usdz-venv/bin/python tools/capture-pipeline/repro.py [OUT_DIR]
```

This builds the converter's `make_fixtures` packages and runs eight cases:

| Case | Expected verdict |
| --- | --- |
| pass | `pass-bounds-only` |
| wrong held-out | `evaluation-failed` |
| no units | `rejected-conversion` |
| unauthored subdivision | `rejected-conversion` |
| NaN point | `rejected-conversion` |
| external reference | `rejected-conversion` |
| size limit | `rejected-input` |
| entry limit | `rejected-input` |

It prints one line per case and writes each report to `OUT_DIR`. It exits 0 only if every case matches.

## Tests (local-only; no CI)

```sh
/workspace/usdz-venv/bin/python -m unittest discover -s tools/capture-pipeline/tests -v
/workspace/usdz-venv/bin/python -m unittest discover -s tools/capture-mesh-convert/tests -v
python3 -m unittest discover -s tools/capture-fit-eval/tests -v
```
