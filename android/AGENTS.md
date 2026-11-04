# Android app (android/)

Native Android companion for the Counterpart Mac app: Kotlin + Jetpack Compose, Gradle (AGP 8.7, Kotlin 2.0), minSdk 26.
Read `android/README.md` first.

- It speaks the iPhone app's protocol to the unchanged Mac companion. `pairing/`, `net/` and `api/` are ports of
  `packages/CounterpartKit` (Swift); keep them in step, file for file, when the wire changes
  (`docs/protocols/objects-api.md`, `docs/protocols/events.md`).
- Don't change the Mac app or `services/companion` for Android unless there's no phone-side way; say why if you do.
- Tests (`./gradlew testDebugUnitTest`) read the shared fixtures in `packages/contracts/fixtures` and
  `packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures`; add cases there, not copies here.
- Build: `./gradlew assembleDebug`; lint: `./gradlew lintDebug`. Never commit `local.properties` or `build/`.
- Pinning rules in `net/Transport.kt` and `pairing/` must not loosen (see README, "Security rules").
- Scanning sends JPEG capture frames for the computer to rebuild (no depth). AR captures also send capture-camera v1
  (saved-byte hashes, saved sizes/intrinsics, timestamps, camera centres) and start with `cameraMetadataRequired`;
  every Android capture starts with `scaleQualificationRequired`, gated on `/healthz` `reconstructionReviewV1`.
  Reconstruction reviews are answered in `ui/ReconstructionReview.kt` against the real preview mesh — never
  through Best Guess/closeup. It is still a first version.
- Not verified on a device or against a real Mac yet: say so in any claim about it working.
