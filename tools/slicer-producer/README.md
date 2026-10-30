# Offline slicer producer (operator-only, macOS)

`producer.py` wraps the BambuStudio CLI (tested target: **02.08.02.61**). It turns one source STL into standalone G-code (`plate_1.gcode`) **and** a sliced `.3mf` project (`sliced-plate.3mf` by default, never `*.gcode.3mf`), binding the model, presets, bundle resources, binary and outputs by SHA-256. It fails closed. It is operator-only: there is no job queue, HTTP, UI or printer integration, and it never prints or dispatches anything.

## Operator command (macOS)

```sh
python3 tools/slicer-producer/producer.py part.stl \
  --out ~/slices/part-a1-pla \
  --machine "Bambu Lab A1 0.4 nozzle" \
  --process "<bundled process preset name>" \
  --filament "<bundled filament preset name>" \
  --expected-binary-sha256 <sha256 of Contents/MacOS/BambuStudio> \
  --expected-input-sha256 <sha256 of part.stl> --expected-input-bytes <size of part.stl>
```

- **Defaults:** `--bundle /Applications/BambuStudio.app`, `--expected-version 02.08.02.61`, `--timeout 45`, `--three-mf-name sliced-plate.3mf`. The timeout must be in (0, 600] seconds.
- **3MF naming rule:** `--three-mf-name` must be a single safe basename ending in `.3mf` and **never** `.gcode.3mf` (on P1S, `*.gcode.3mf` triggers `bambu-printer-mcp`'s legacy `gcode_file` route, which refuses AMS jobs).
- **Sandbox:** fixed to the platform primitive `/usr/bin/sandbox-exec`, which must be root-owned and not group- or world-writable. There is no option to substitute another sandbox. On any platform other than macOS the run is refused.
- **Input pins:** `--expected-input-sha256` and `--expected-input-bytes` reject the model unless its bytes match.
- **Preset names** are file stems under `BambuStudio.app/Contents/Resources/profiles/BBL/{machine,process,filament}/`. List them with `ls` and pass the stem without `.json`.
- **Optional validated overrides:** `--bed-type {cool_plate,engineering_plate,hot_plate,textured_plate}` (sets `curr_bed_type` in the flattened process preset; `supertack_plate` is refused in CLI mode), `--nozzle-type {stainless_steel,hardened_steel,tungsten_carbide,brass}` (sets `nozzle_type` in the flattened machine preset so non-stock hotends match `inspect_print_file` and printer preflight), and `--enable-support {0,1}` (explicitly disables or enables support generation in the flattened process preset). All overrides are applied before hashing and post-run sealing, and are recorded under `manifest.overrides`.
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
4. **Sandboxed slice.** The command always runs under the trusted `/usr/bin/sandbox-exec`. If it is missing or untrusted, or the platform isn't macOS, the run fails; there is no unsandboxed, degraded or injected-sandbox mode. The generated profile:
   - denies `network*`, `mach-lookup` (default-deny) and `signal`, allowing only the narrow 3-service Mach-lookup set (`com.apple.windowserver.active`, `com.apple.coreservices.launchservicesd`, `com.apple.MTLCompilerService`) required by BambuStudio's plate-thumbnail renderer during `--export-3mf`
   - denies writes outside scratch
   - denies reads of `~/Library`, `~/.ssh` and `~/.config`

   The run also:
   - uses a fresh `--datadir`
   - passes only `PATH`, `LANG`, `TMPDIR` and `HOME` (scratch), with no inherited credentials
   - runs in its own process group under a hard deadline, which still applies after the child closes its pipes. The group gets SIGTERM, then SIGKILL after a 2 s grace, and is always reaped.
   - bounds the log at 5 MiB
   - exports standalone `plate_1.gcode`, `exported-settings.json` (`--export-settings`), and the sliced 3MF project (`--export-3mf <name>.3mf`, never `*.gcode.3mf`).
5. **Acceptance.**
   - The run must exit 0.
   - The output directory must contain `plate_1.gcode`, `<three-mf-name>` (`sliced-plate.3mf` by default), and `exported-settings.json`, plus optionally the CLI receipt `result.json`. Any other file is rejected. Every file must be regular and non-empty.
   - The exported `.3mf` archive is opened and verified under bounded read/decompression budgets: it must contain non-empty `Metadata/plate_1.gcode`, valid JSON `Metadata/plate_1.json`, `Metadata/slice_info.config`, `[Content_Types].xml`, and a `3D/*.model` entry, and the SHA-256 of embedded `Metadata/plate_1.gcode` must match standalone `plate_1.gcode`.
   - The settings must be valid JSON. `result.json`, when present, must be a JSON object whose `return_code` (if given) is 0. It is hashed and published.
6. **Budgets.** Every read is bounded before allocation: a stat check, then reading at most limit+1 bytes. The limits cover:
   - input model: 64 MiB
   - each preset file: 1 MiB, with at most 64 preset files and nesting depth 16
   - bound resources and Info.plist
   - total outputs (and `.3mf` uncompressed archive contents): 512 MiB, monitored during the run
   - exported settings and `result.json`
   - log: 5 MiB

   Exceeding any of them fails the run.
7. **Seal.** After the run, these are re-hashed and must match the identities recorded before launch:
   - bundle identity (binary, Info.plist, bound resources)
   - scratch model copy
   - each flattened preset file
   - every contributing bundled preset source
   - the sandbox profile

   Any mutation fails the run. The scratch inputs are also made read-only.
8. **Atomic, exclusive publish.** The files are staged next to `--out`, verified (including staged `threeMf` SHA-256), then published with an exclusive rename: `renamex_np(RENAME_EXCL)` on macOS, `renameat2(RENAME_NOREPLACE)` on Linux. That never replaces a destination that appears during publication, even an empty directory. `--out` must not already exist. On any failure, nothing is published and scratch is removed.

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
- `outputs`: `gcode`, `threeMf` (including `sha256`, `bytes`, `plateGcodeInternalPath`, `plateGcodeSha256`, `plateGcodeBytes`), `gcodeSummary`, `exportedSettings`, and optional `cliResult`

The manifest deliberately does **not** claim a slicer-settings digest. `exported-settings.json` is hashed as an observed artifact only.

`notClaimed` lists what the manifest doesn't prove:
- effective-settings equivalence
- determinism
- zero attempted network calls (denial is enforced; attempts aren't observed)
- printability, fit, or permission to print

## Tests (Linux or macOS; no slicer needed)

```sh
python3 -m unittest discover -s tools/slicer-producer/tests -v
```

The tests build a fake `BambuStudio.app`, with a Python stub slicer and synthetic presets, plus a fake `sandbox-exec`. The fake checks the profile's deny rules and then execs the stub. The fake sandbox is injected only through the test-only `produce(..., _sandbox=...)` seam; the CLI has no way to set it. That covers the success path and fail-closed negatives:
- nonzero exit, missing G-code, missing or invalid settings export, unexpected 3MF, timeout
- missing sandbox
- preset symlinked outside the bundle, traversal name, `inherits` escape, missing preset, inheritance cycle
- version mismatch, binary pin mismatch, missing `cli_config.json`
- zero-normal binary STL, non-STL input
- existing output directory, CLI exit 2
- review regressions:
  - `result.json` accepted, and a nonzero `return_code` rejected
  - no `--sandbox-exec` CLI option, and the platform refusal
  - deadline after EOF with SIGTERM ignored
  - input, preset, depth, count, output and timeout budgets
  - expected input digest and size
  - flattened-preset, scratch-model and bundle-source mutation
  - destination created during publish is not replaced

The real installed runtime is not exercised by these tests. Run the operator command above on the Mac to reproduce it.
