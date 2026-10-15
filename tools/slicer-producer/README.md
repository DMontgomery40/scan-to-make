# Offline slicer producer (operator-only, macOS)

`producer.py` wraps the BambuStudio CLI (tested target: **02.08.02.61**). It turns one source STL into G-code and binds the model, presets, bundle resources, binary and outputs by SHA-256. It fails closed. It is operator-only: there is no job queue, HTTP, UI or printer integration, and it never prints or dispatches anything.

## Operator command (macOS)

```sh
python3 tools/slicer-producer/producer.py part.stl \
  --out ~/slices/part-a1-pla \
  --machine "Bambu Lab A1 0.4 nozzle" \
  --process "<bundled process preset name>" \
  --filament "<bundled filament preset name>" \
  --expected-binary-sha256 <sha256 of Contents/MacOS/BambuStudio>
```

- **Defaults:** `--bundle /Applications/BambuStudio.app`, `--sandbox-exec /usr/bin/sandbox-exec`, `--expected-version 02.08.02.61`, `--timeout 45`.
- **Preset names** are file stems under `BambuStudio.app/Contents/Resources/profiles/BBL/{machine,process,filament}/`. List them with `ls` and pass the stem without `.json`.
- **Binary pin:** `--expected-binary-sha256` is optional but recommended. Get the value from `shasum -a 256 /Applications/BambuStudio.app/Contents/MacOS/BambuStudio`.
- **Exit codes:**
  - `0`: the output directory was published.
  - `2`: failure, with a JSON `{"error": {stage, message, evidence}}` on stderr. Nothing is published.

## What a run does

1. **Bundle identity.**
   - `Info.plist` version must equal `--expected-version`.
   - The binary is hashed, and checked against the pin if one is given.
   - Bundled resources that the CLI reads on its own are hashed: `profiles/BBL.json` and `profiles/BBL/cli_config.json`. `cli_config.json` applies machine limits, so it's part of the effective inputs.
2. **Presets, from the bundle only.**
   - Each name resolves to `profiles/BBL/<kind>/<name>.json`, and its real path must stay inside `Contents/Resources/profiles`. Symlinks and `..` escapes are rejected.
   - `inherits` is merged first, then `include`, then the file's own keys. Every contributing file is recorded with its SHA-256, and cycles and missing parents are rejected.
   - The flattened, complete files are written only to a temp scratch directory. No preset copies are kept in Git or in the output.
3. **Input.** The STL bytes are copied into scratch and hashed. A binary STL must have unit-length facet normals, because zero normals are rejected by the slicer. An ASCII STL must be well-formed. Anything else is rejected.
4. **Sandboxed slice.** The command always runs under `sandbox-exec`. If `sandbox-exec` is missing, the run fails; there is no unsandboxed or degraded mode. The generated profile:
   - denies `network*`, `mach-lookup` and `signal`
   - denies writes outside scratch
   - denies reads of `~/Library`, `~/.ssh` and `~/.config`

   The run also:
   - uses a fresh `--datadir`
   - passes only `PATH`, `LANG`, `TMPDIR` and `HOME` (scratch), with no inherited credentials
   - runs in its own process group, which is killed after the run or on timeout
   - bounds the log at 5 MiB
   - produces G-code only, plus `--export-settings`. 3MF export is never requested, because thumbnail rendering needs OpenGL/IPC, which the sandbox denies.
5. **Acceptance.** The run must exit 0, and the output directory must contain exactly `plate_1.gcode` and `exported-settings.json`: regular, non-empty files, with the settings as valid JSON. The bundle identity and scratch input are re-checked after the run.
6. **Atomic publish.** The files are staged next to `--out`, verified, then published with one `rename`. `--out` must not already exist. On any failure, nothing appears at `--out` and scratch is removed.

## Manifest (`manifest.json`)

`slicer` records:
- bundle version and build, and the `Info.plist` hash
- binary SHA-256
- bound resource SHA-256s

`presets.<kind>` records:
- the name, the flattened SHA-256 and size
- every source file in the bundle, with its SHA-256

Other fields:
- `input`: file name, format, SHA-256, size
- `invocation`: argv with scratch paths normalized to `<scratch>`, environment keys, sandbox profile SHA-256, timeout
- `outputs`: G-code and exported-settings SHA-256 and size

The manifest deliberately does **not** claim a slicer-settings digest. `exported-settings.json` is hashed as an observed artifact only.

`notClaimed` lists what the manifest doesn't prove:
- effective-settings equivalence
- determinism
- zero attempted network calls (denial is enforced; attempts aren't observed)
- 3MF export
- printability, fit, or permission to print

## Tests (Linux or macOS; no slicer needed)

```sh
python3 -m unittest discover -s tools/slicer-producer/tests -v
```

The tests build a fake `BambuStudio.app`, with a Python stub slicer and synthetic presets, plus a fake `sandbox-exec`. The fake checks the profile's deny rules and then execs the stub. That covers the success path and fail-closed negatives:
- nonzero exit, missing G-code, missing or invalid settings export, unexpected 3MF, timeout
- missing sandbox
- preset symlinked outside the bundle, traversal name, `inherits` escape, missing preset, inheritance cycle
- version mismatch, binary pin mismatch, missing `cli_config.json`
- zero-normal binary STL, non-STL input
- existing output directory, CLI exit 2

The real installed runtime is not exercised by these tests. Run the operator command above on the Mac to reproduce it.
