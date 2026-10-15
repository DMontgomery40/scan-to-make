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

## Bounded duplicate

`duplicate.py` makes an exact copy of a qualified capture for printing, or rejects it. It runs `pipeline.py` first and then gates the converted mesh:

1. **Pipeline gate.** Only `pass-bounds-only` is eligible. Every other pipeline verdict is passed through with its exit code, and nothing is written.
2. **Strict reader.** The converter OBJ may contain only `v x y z`, triangular `f a b c`, `o` and comments. N-gons, texture or normal indices, other directives, non-finite coordinates and out-of-range indices give `rejected-topology` (exit 7). Faces are never re-triangulated or dropped.
3. **Closed solid, checked here.** The mesh must have zero boundary edges, zero non-manifold edges, consistent orientation, zero degenerate triangles and positive signed volume. An open or broken surface gives `rejected-topology` with the counts as evidence. **No surface is invented to close it**: no capping, hole filling or repair.
4. **Bounds.** `--max-vertices` (default 1,000,000), `--max-triangles` (2,000,000) and `--build-volume XxYxZ` in mm (default 256x256x256). Native extents are converted to mm only for the comparison, with the exact map mm=1, cm=10, in=25.4, m=1000. A violation gives `rejected-bounds` (exit 6). The mesh is never scaled, rotated or moved to fit.
5. **Exact copy.** `duplicate.obj` is the converter OBJ copied byte for byte. It is re-read and checked against the converter's SHA-256 before the verdict is `duplicate-ready` (exit 0). Units stay as authored and are recorded in the manifest (`units`, `metersPerUnit`, `mmPerUnit`); `scaleApplied`, `geometryModified` and `surfacesInvented` are always `false`. A stale `duplicate.obj` in the output directory is removed at the start of every run, so a rejection never leaves an old copy behind.

The manifest is deterministic JSON in the same style as the pipeline report, with paths normalized to `<out>`, `<work>`, `<repo>` or `<input-dir>`. It embeds the full pipeline report. `provesCompleteCapture` and `provesPhysicalFit` stay `false`: a ready duplicate is a closed, bounded, exact copy of what was captured, not proof that the capture is complete or that the print will fit.

```sh
/workspace/usdz-venv/bin/python tools/capture-pipeline/duplicate.py capture.usdz \
  --held-out x=80 --held-out y=55 --held-out z=95 \
  --work-dir /tmp/capture-work --out-dir /tmp/capture-duplicate --report capture-duplicate.json
```

Exit codes: 0 duplicate-ready, 2 evaluation-failed, 3 rejected-input, 4 rejected-conversion, 5 rejected-units, 6 rejected-bounds, 7 rejected-topology.

One-command synthetic repro (six cases: ready, wrong held-out, holes, no units, over build volume, over triangle limit):

```sh
/workspace/usdz-venv/bin/python tools/capture-pipeline/duplicate_repro.py [OUT_DIR]
```

## Tests (local-only; no CI)

```sh
/workspace/usdz-venv/bin/python -m unittest discover -s tools/capture-pipeline/tests -v
/workspace/usdz-venv/bin/python -m unittest discover -s tools/capture-mesh-convert/tests -v
python3 -m unittest discover -s tools/capture-fit-eval/tests -v
```
