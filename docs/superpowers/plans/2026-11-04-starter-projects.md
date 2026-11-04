# Starter projects implementation plan

> Implement directly with superpowers:executing-plans. User has asked to proceed without additional design approval.

**Goal:** Three clean useful starter projects, including a six-plate print workflow.
**Architecture:** Existing published file receipts are the plate catalog. Companion owns selection and persisted progress; shared Swift models and views display it in both clients. Curated starter manifests create fresh projects, never copy personal projects.
**Tech Stack:** TypeScript companion, SwiftUI, CounterpartKit, existing printer MCPs.
**Spec:** ../specs/2026-11-04-starter-projects.md

## Constraints and review focus

- Keep source 3MF bytes, identities, colours and all plates intact.
- Prevent selection races with printing; never count accepted dispatch as completion.
- Keep previous successful completion when a reprint fails, and never transfer progress to different file bytes.
- No personal history in starters; repeated taps must not create accidental duplicates.
- No MCP release, hardware dispatch or new device installation in these implementation checks.

## 1. Plate selection and progress

- [x] Add failing companion tests in `services/companion/tests/published.test.mjs` for six-plate selection after the initial Ask, switching after completion, restart persistence, failed/cancelled prints, invalid indices and busy/uncertain locks.
- [x] Add `objects/plates.ts`, `ObjectService.selectPlate`, HTTP/socket operations, frozen print plate identity and bounded progress retention.
- [x] Add shared plate wire model/picker and client methods. Connect phone `ProjectView` and Mac `ProjectDetail` to selection and normal Print sheets.
- [x] Run companion tests on Linux; shared/native compilation under the Apple build lock. Commit and push.

## 2. Starter catalog

- [x] Inspect available original model metadata and licences; finish Counterpart card branding and QR from generator source.
- [x] Create curated manifests, previews and import action; surface on welcome, phone Home and Mac empty workspace.
- [ ] Verify fresh project has no inherited messages, passes, personal photos/settings or print activity; verify external import and all six platform plates.
- [x] Commit and push; update handoff and prepare the next TestFlight build with integrated provider work.

## Verification and remaining acceptance

- Companion focused review checks: 75 passed, including renamed-file deduplication and manual per-plate Printed acknowledgement.
- Shared Swift: 168 passed; native Mac and iOS builds passed. New first-launch starter detail and six-plate selection/print-sheet UI tests: 2 passed.
- Caliper geometry, QR and shipped assets: 13 checks passed.
- Six-plate behavior uses a synthetic fixture. Actual Kass 3D six-plate original import and physical prints remain unaccepted. The original is not bundled; both MakerWorld starters request their designer’s files, as PRD §15 requires.
- Provider integration is in build 2.0 (2), now waiting for external Beta App Review. Final Linux Node 22/24 workflows each pass 792 companion tests, one skip and 55 contracts. Clean-project isolation is tested; actual original scan-rig import remains open.
