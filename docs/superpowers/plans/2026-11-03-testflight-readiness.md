# External TestFlight readiness implementation plan

> Execute the independent diagnostics in parallel, then integrate and validate in this session. Continue under David's instruction to finish the checklist and publish an external beta with a public link.

**Goal:** Finish the remaining Counterpart checks and deliver a tested external TestFlight build and public link.
**Architecture:** Keep printer behavior in the two MCPs, preserve the native iPhone/Mac clients and companion contracts, and use Apple's distribution and capture frameworks.
**Tech stack:** SwiftUI, Object Capture, CloudKit, ActivityKit, TypeScript companion/MCPs, Xcode/App Store Connect.
**Spec:** `docs/status/asks.md`, `docs/status/handoff.md`, `docs/design/overhaul/PRD.md`.

## Constraints

- Preserve projects, pairings and active work. Do not add user memories.
- No bed/plate prompts. Keep the five-second FULU control hold and checked resume behavior.
- Both MCPs receive shared fixes; their npm releases remain held unless David changes that decision.
- Device acceptance means the real app and observed result, not a mock or a build.
- Publish to external testers by public link; retain honest distinctions between uploaded, processing, review and approved.

## Review focus

- Unknown or timed-out connectivity must not display Connected.
- Each event produces one alert; Live Activities finish on every terminal event and do not orphan on retry.
- Production TestFlight uses production push/CloudKit configuration and an installable companion.
- Phone controls and settings use the same MCP-backed contracts as Mac, including pending Resume confirmation.
- A scan must capture the object with adequate coverage and release the camera; topology alone does not establish quality.

## Tasks

- [ ] Connectivity: reproduce the unknown-state label and hanging request; add regressions in mobile AppTests/shared transport tests; fix `SettingsView`, `ProjectsStore` and the exact failing transport boundary. Validate simulator states and the live phone.
- [ ] Notifications: establish one alert owner using the existing relay/subscription design; regress duplicate event handling, `print.not-started`, retries and ending activities in `EventRelayPolicy` tests; fix the owned relay/subscription files and verify real delivery.
- [ ] Phone parity: compare `PrintersView`, print sheet and confirmation with current companion routes; implement missing route/MCP/layer-pause controls with contract tests; build and test on the phone.
- [ ] Remaining checklist: audit open PR integration and rows 5–42 against current source/device evidence; implement each confirmed defect with a failing regression, a minimal fix and passing checks. Keep physical capture/Face ID/Watch checks explicitly pending until actually observed.
- [ ] Distribution: inspect current Apple account/app/signing setup and latest Apple release requirements; prepare production services, beta description, test instructions and review details; archive and validate the exact tested source; upload, submit beta review and enable the external group's public link when allowed by App Store Connect.
- [ ] Record evidence in the existing handoff/asks files, push each completed feature, and remove only owned temporary build/probe artifacts.

## Execution record

2026-11-03: David chose external testers via public link. Mac FULU controls already accepted; this plan begins after those fixes. A developer-tool connectivity result is not evidence that the phone app is disconnected.
