# Preserved capture reconstruction audit — 2026-11-02

Ask 7 remains partially unverified. The recorded walk-around scan produces a recognizable, exportable model, but its rear surface is incomplete. The recorded in-hand scan still does not produce the intended object. A successful Apple reconstruction or closed STL alone does not establish capture quality.

This was an **offline audit**, with no iPhone UI, camera, printer dispatch, live Blender scene, or AI cleanup worker interaction. Apple reconstruction and headless rendering ran serially under `~/.stm-ios.lock` after the integration builds. All original HEIC files and the saved phone USDZ remained byte-identical. New evidence totals about 43 MB; temporary Swift build caches were removed.

## Inputs and current production route

Preserved backup: `/Users/davidmontgomery/scan-to-make-work/davica3-counterpart-backup-20261102-0401/Documents`.

- Walk-around: `NativeCaptures/ce42012e-ed16-4f6f-9268-5c9f9ac7bb8b`, 117 HEIC images, saved `Models/model-mobile.usdz` (7,088,924 bytes; SHA-256 `780b4acd5422253e13d4b866a7252d08889d62547b2c877341a2ca1b375bb9ba`). The evaluation records three passes, two flips, `stitchingIncomplete`, and false complete-object/physical-fit verification.
- In-hand: `HandheldCaptures/485defc7-73d1-4c4e-901d-57e27d709088`, 120 HEIC images of a metal multitool held in a hand. No input was rewritten, cropped, rescaled or given a new mask for this run.

The phone's `MacConnection.sendCapture` sends the **saved phone USDZ plus up to 24 spread photos**. `ObjectService.addScan` stores that USDZ; `ObjectService.#run` sends it into `runTouchup`, which prepares a private pass and invokes the Blender/Claude worker. The worker exports millimetre STL; `isValidStl` checks complete, finite triangles before the service installs the result. The older `capture_convert`/`ScanProcessingStore` adapter is **not on this current object workflow**. Its converter was used here as an independent USD units/geometry check only.

In-hand uses a different path: numbered HEIC/depth inputs → `ObjectService.#build` → `macReconstructRunner` → `samples … full --save-masks …` → the same touch-up workflow. Its production default still uses custom Vision masks. The runner currently discards helper stderr, which limits diagnosis of failures; the audit explicitly retained stdout and stderr.

## Replays and geometry

Commands used the repository's `mac-reconstruct` helper built from `0166058a`, SHA-256 `534a75932f3fbe7d8c349a31fdcf6a2328ad4ed8685938b203646dcd9de805f4`. Each replay had a 480-second cap and retained command, timestamps, input hashes, output hash, stdout and stderr.

| Input / mode | Result | Geometry review |
| --- | --- | --- |
| In-hand: `samples <120 HEIC> <new USDZ> full --no-masks` | Exit 0, 63.4 s, 4,412,676-byte USDZ; 58 samples reported unused | **Rejected.** 12,026 triangles; PCA extents 107.4 × 54.4 × 24.4 mm. Hand-colored rounded slab and finger-like protrusion; the multitool's handles, pivot and metal edges are absent. |
| Walk-around: `<117 HEIC> <new USDZ> full` | Exit 0, 74.3 s, 16,202,491-byte USDZ; 79 samples reported unused | Recognizable front, arms, sign and crochet texture, but a large smooth/blurred region on the rear. 27,092 triangles; PCA extents 75.4 × 65.7 × 49.1 mm. **Not complete-capture acceptance.** |
| Saved phone walk-around USDZ | Re-read, rendered and exported independently | Recognizable front, arms, sign and crochet texture, with a similar large rear defect. 10,848 triangles; PCA extents 75.3 × 62.8 × 48.6 mm. Shallow facial features are conveyed largely by texture, which an STL does not preserve. |

PCA extents describe the generated geometry; they are **not caliper measurements**. Render orientation can reverse between models when their principal axes differ. Inspect both front and back rather than comparing one named view.

The fresh Mac reconstruction is an additional replay, not a reproduction of the iPhone reconstruction environment. The iPhone uses `.reduced` and its Object Capture checkpoint directory. Apple's current documentation says Mac reconstruction starts from scratch even when a checkpoint directory is supplied; it cannot resume the saved iOS capture checkpoint. No original checkpoints were handed to a writer.

## Real import/export and acceptance checks

Both walk-around USDZs were imported in a separate **Blender 5.0.1 background process**, with a factory scene and packed textures. No modeling edits were made. Source metres were exported with scale 1000 to millimetre STL. Independently parsed output:

| Output | Triangles / vertices | Axis-aligned extents, mm | Topology |
| --- | --- | --- | --- |
| Saved phone model → `walkaround-export/export-mm.stl` | 10,848 / 5,426 | 61.641 × 75.247 × 50.259 | Closed oriented; zero boundary/nonmanifold edges and zero degenerate triangles |
| Fresh Mac rebuild → `walkaround-apple-rebuild/export-mm.stl` | 27,092 / 13,548 | 62.218 × 75.571 × 51.545 | Closed oriented; zero boundary/nonmanifold edges and zero degenerate triangles |

Both passed **the actual installed companion's `isValidStl` function**, imported from its packaged `dist/touchup/runner.js`. The original model's independent USD→OBJ conversion reports authored `metersPerUnit=1`, authored Y-up, and no unsupported geometry features. Its output and Blender's STL retain the same triangle/vertex count, volume and axis-permuted extents within floating-point conversion precision. This validates conversion integrity, not physical accuracy. The converter reports an explicit base-colour border-wrap approximation.

These checks exercised real reconstruction, USD import, STL export and production file acceptance. They **did not exercise phone Send, the AI cleanup worker, the service's ready-state transition, printing, or physical fit**. The closed rear patch is a direct example of why closed topology is insufficient evidence of complete capture.

## Bounded change and remaining work

`model-look --all-views` now adds back, opposite-side and bottom views to its existing front/side/top renders. Default output remains three views. Built the changed Swift source and inspected all 36 clay/textured images across the three models; all are nonblank 900×900 PNGs. The reverse view exposed the rear defect that the initial front-only inspection missed.

No production mask default was changed. Apple's automatic-mask baseline avoided the previous process error but chose the wrong subject. Earlier high-sensitivity custom-mask/SAM replays also produced rejected geometry, so neither a successful exit nor another parameter change justifies enabling in-hand scanning. Keep its existing unavailable state until a new controlled capture demonstrates the intended object with usable geometry.

The evidence supports these next checks:

1. Walk-around on the installed phone: capture → reconstruction terminal result → explicit Send → actual cleanup result and six-sided inspection. A saved model replay does not prove the current camera UI or upload journey.
2. Carry Apple's `stitchingIncomplete` warning into the user's model review so an unjoined side is not mistaken for complete coverage; preserve the scan and allow review/retry rather than deleting it.
3. For a future in-hand attempt, establish subject isolation, sharp overlapping stills and sufficient object size in frame before changing reconstruction settings. The current images contain a small reflective metal object touching a much larger hand. This is consistent with Apple's documented difficult-input conditions, but does not identify a unique internal cause of the earlier `processError`.
4. Retain bounded private helper diagnostics for future failed runs. Current `reconstruct.ts` loses stderr and only exposes the generic saved-photos error.

## Evidence and primary references

Local artifact root: `/Users/davidmontgomery/scan-to-make-work/codex-capture-audit-20261102`.

- `inhand-apple-masks/{command.json,result.json,inputs.json,stdout.jsonl,stderr.log,model.usdz}` and six `clay-*` / six `textured-*` PNGs.
- `walkaround-apple-rebuild/`: equivalent replay files, six-sided renders, `export-mm.stl`, `blender-export.json`, `topology.json`, `production-acceptance.json`.
- `walkaround-export/`: independent `conversion.json`, OBJ/material/texture, original-model six-sided renders, exported STL and topology/acceptance reports.
- `render-verification.json`, `source-preservation.json`, scripts and three small helper binaries. Recorded inputs remain in the original backup, not duplicated here.

Apple documentation read on 2026-11-02:

- [Object masking](https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/isobjectmaskingenabled): with masking enabled and no supplied masks, RealityKit attempts automatic masking; it may use the entire image if masking fails.
- [Capturing photographs](https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture): rigid subject, substantial overlap, subject filling the frame, consistent settings and diffuse lighting; reflective/smooth surfaces are difficult.
- [Creating objects from photographs](https://developer.apple.com/documentation/realitykit/creating-3d-objects-from-photographs): default settings first, higher feature sensitivity for suitable difficult inputs; handle skipped/invalid samples and request errors.
- [Checkpoint directory](https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/checkpointdirectory): iOS checkpoint reuse differs from Mac scratch reconstruction.
