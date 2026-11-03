# David's asks: status

Every request David has made for Counterpart, updated 2026-11-02 at 14:10 Mountain.
Relay update at 20:29 Mountain: the Sandbox Worker is deployed and returns `503 not_configured`.
Key registration/upload is authorized but blocked by expired Apple sign-in and disabled browser
access; no APNs authentication or phone delivery is claimed. See the latest handoff section.
All 40 asks remain in scope. PRs #259–#285 are merged. Both Mac and phone have signed build
`202611021355` from reviewed `184a7d4d`, whose entire source tree matches merged `4c7af6a5`.
The Mac runtime was rebuilt from that same source. Local Bambu 1.1.52 remains `ed9aba3`,
with Fusion CLI/add-in `86a3016`; no public MCP release. Six original projects/photos and
seven pairings survived installation and the disposable acceptance import unchanged.
How to pick up this work, and the diagnosis notes behind the P0 rows: [`handoff.md`](handoff.md).

**Done means David can do it on his own device.** "Merged" isn't done. Status values:
- **on device**: installed on his device and checked there;
- **installed**: on his device, but nobody has confirmed it on his screen yet;
- **merged**: on main, but not on his device;
- **branch**: a PR or branch exists;
- **not started**.

The owner is whoever the lead assigns. Repeats count how often the ask came up again.

| # | Ask | Repeats | Status | Done when |
|---|---|---|---|---|
| 1 | Printing works from the app (stove strips) | many | **partially verified**: reviewed local Bambu MCP 1.1.52 at `ed9aba3` and app #268/#277 are installed. Small STL/two-copy slicing produces two objects on one plate. The real stove/two-copy sheet now explains that two separate plates are required and disables Print; changing to one copy restores Fine / 4 h 48 min / 104 g and enables Print. No new physical print dispatched; original toolhead-cover failure remains historical evidence. Public MCP release is held | He presses Print in the app and the part prints |
| 2 | Stop/cancel from the app actually stops the printer | 1 | **installed, unverified stop**: cancel capability and QoS 1 implementation were confirmed in the 1.1.51 audit; reviewed local 1.1.52 is now installed. No running print was stopped during this audit | Stop in the app stops the printer |
| 3 | Done / Works status | 7 | **on device, both** (#240; Mac at `91734f0`, phone at `c2eb1e0`) | Marks the mic mount Done on both |
| 4 | Rename projects | 2 | **installed #259; acceptance partial**: Mac rename saved and restored on the real stove project; phone rename saved from its native dialog and was read back from the Mac on a disposable duplicate; generated titles cannot overwrite a rename | Taps the name and renames, on both |
| 5 | Project settings (printer, colours, quality, copies, engine, notifications, files, duplicate, archive/delete) | 2 | **installed; Mac acceptance partial, [PR #260](https://github.com/DMontgomery40/scan-to-make/pull/260)**: unified native Project Settings on both; saved printer/colour/quality/strength/copies, next-pass engine, print alerts, original-file export and independent Duplicate implemented and tested. The installed Mac independently duplicates the model, renames the copy, saves Fine/two-copy defaults and carries them into Print. The two-copy defect is now handled as described in row 1. The temporary acceptance copy was removed after verification; six original projects and seven pairing identities remain unchanged. Phone native Project Settings now saves Fine/two-copy defaults on a disposable duplicate and produces a real 1 h 49 m / 37 g / 452-layer estimate in its Print sheet. Sheet canceled and only the duplicate removed; originals/pairings preserved. Remaining settings still need acceptance | Each setting works on both |
| 6 | Claude names projects | 1 | on device (failed captures still unnamed) | Every project has a real name |
| 7 | Scanning works at all | many | **not accepted on device**: recorded walk-around phone and Mac models both have an incomplete rear; Apple-only in-hand replay reconstructs the hand instead of the object. Valid STL/topology checks pass but quality fails; in-hand remains off | A walk-around scan becomes a model; then in-hand |
| 8 | Scanner must not brick the phone camera / Face ID | 1 | **phone 1355 installed; device acceptance pending**: #271 fixes a concrete physical-camera consumer: ordinary iOS RealityView model previews now explicitly use a virtual camera. #259 handles interruptions and retry. No evidence establishes a hardware fault or proves the recurring camera/Face ID issue resolved | Camera and Face ID fine after scanning |
| 9 | One app, named Counterpart, one icon; old "Scan to Make" builds gone | 2 | **on Mac, registry verified**: `/Applications/Counterpart.app` is the only Launch Services registration for `com.scantomake.mac` after unregistering 125 obsolete build/Trash entries. Files were not deleted by that operation. One immediate app rollback is retained without an app extension; future build products must be unregistered after deployment | Only "Counterpart" in Applications/Spotlight |
| 10 | Real apps look like the mockups | 2 | **Mac model display verified; full parity still open**: installed #275 shows the actual mic mount on a transparent stage, enters 3D and returns to its still. Conversation bubbles are present. Comparison with the mockup confirms the main composition, not every screen. New Project preview overflow is fixed in #278 and verified on Mac 1215 at 1320 × 820; phone Home, model display, Project Settings and actual print estimate are now observed; full mockup parity remains open | Side-by-side with his real projects matches |
| 11 | Home grid: equal, inset, spaced cards, nothing overlapping | 2 | **on phone, observed**: two equal inset columns with separated cards on connected Home (#243) | Two equal columns, 16 pt margins, 12 pt gutter |
| 12 | Home title isn't "Counterpart" | 1 | on device (`1925de5`) | — |
| 13 | No fake controls (mic button etc.) | 1 | on device (`1925de5`) | — |
| 14 | Search matches notes and every field | 1 | **on device, both**: search for “25 inches” finds the stove project from its conversation, on Mac and phone; internal IDs/paths remain excluded | Searching a follow-up word finds the project |
| 15 | State is right: "working" while a pass runs, never "Ready to print" mid-change | 2 | **installed #259/#277**: ordered reads reject stale responses; mutations take tickets before sending. #277 fixes a real print incorrectly marked Done from a FINISH report observed 2.3 seconds before dispatch. Installed on Mac 1121. Empty idle drafts no longer claim an active transfer | A follow-up shows Working until done, on both |
| 16 | Phone never says "Mac isn't answering" when it is | 1 | **installed from prior work; long-run acceptance pending**: actual phone Home says Mac mini connected / 1 printer ready; no new one-hour connectivity claim | Stays connected on Home for an hour |
| 17 | Mac and phone allow the same actions (Ask for changes) | 1 | **installed #259; acceptance partial**: both clients queue changes during work/printing; uncertain sends pause for Retry/Discard | Same actions available on both |
| 18 | Conversation as message bubbles, photos with their message | 1 | **installed #259; acceptance partial**: chronological native bubbles; new photos belong to their actual message. Historical unknown ownership is not invented | Bubbles on both |
| 19 | "DONE / it works" message doesn't start a design pass | 1 | **installed #259; acceptance partial**: success reports, including photos, mark Done without a design pass; uncertain classification saves the message; Undo supported | Message marks Done instead |
| 20 | Notifications (ready, question, halfway with camera frame, done, failed) | 3 | **installed #259/#283; delivery unverified**: missing settings persistence and accidental deletion of account-wide CloudKit subscriptions are fixed. Phone 1355 reports that iCloud alerts include every event type; OS permission is allowed. A genuine temporary import emitted Ready and the Mac recorded its CloudKit save. This is not a phone/Watch delivery receipt. Separate phone/type filters remain unsupported and disabled | Halfway notification with frame on his phone and Watch |
| 21 | Lock Screen / Live Activity print progress | 1 | **installed #259; acceptance partial**: local Lock Screen/Dynamic Island extension and token registration now exist and sign. Sandbox relay is deployed with separate storage and passes the expected missing-credentials probe. Key registration/upload is authorized but blocked by Apple sign-in/browser access. Signed phone 1355 uses development APNs; actual APNs authentication, foreground activity and Lock Screen delivery remain unverified | Live Activity on his Lock Screen |
| 22 | Printer camera efficient (Scrypted-like) | 1 | **installed #262; sustained acceptance pending**: sample taken on reviewed local Bambu MCP 1.1.52 at `d6c1d953` (now `ed9aba3`). Twelve installed-control reads over about 23 seconds had zero errors, at most 8,409 bytes, first read 3.486 s and later reads at most 0.005 s; one shared camera connection closed after idle. Static-camera content was unchanged. This is a bounded sample, not phone or sustained-budget acceptance | Budgets met on his P1S |
| 23 | Getting ready vs printing; printer's own failure text + Print Again | 1 | **on Mac, observed**: original printer failure text and Print Again sheet checked in the real installed app | Shows "Getting ready · …" then real failure text |
| 24 | Print a published model (link → designer's file, credit) | 2 | **installed #273; Mac import/estimate verified**: fresh MakerWorld caliper original imports as Ready through the native app, shows designer/licence/link and plate preview, preserves the exact SHA-256, and produces a real P1S estimate of 1 h 39 m / 40 g. Sheet canceled without dispatch; temporary acceptance project removed. Phone 1355 displays the imported original with designer/licence/plate preview. Automatic browser retrieval, import initiated from the phone, and physical print remain unaccepted | Paste a MakerWorld link and it prints that file |
| 25 | Claude unconstrained on the user's Mac (web, images, browser downloads) | 1 | merged in #219 path; not verified | Link flow downloads via his browser |
| 26 | Fusion as a design engine | 2 | **installed #272; private real-worker pass verified**: actual app worker produced a 10 mm parametric cube, exported STL/F3D, reopened the archive and closed only its two owned documents. Four original document identities/flags and the active stove geometry remained unchanged. Local Bambu `ed9aba3` and durable CLI/add-in `86a3016` are installed; configured SSH verifies binding and visible tool results. New Set Up flow is build/test-verified, not clicked in this acceptance pass | Set up works; one real pass uses Fusion |
| 27 | Update both MCPs from either app | 2 | **installed #259; acceptance partial**: parked updater backend integrated with both clients; print/design/cleanup reservations prevent replacing an MCP in use. Actual app-driven update pending | Update button updates the MCP from the phone and the Mac |
| 28 | Every Mac setting on the phone | 1 | **on device, partial acceptance (#282/#283/#285)**: phone General values now come from the real Mac. Turning keep-awake off on the phone changed the Mac Settings switch; restored on and verified both sides. Current phone is excluded from removable older pairings. AI connection tests and passive Fusion status are visible. Fusion setup and MCP update actions are not clicked in this acceptance; AI provider routing remains unimplemented | Changes a Mac setting from the phone |
| 29 | Phone connects automatically on the same Apple Account | 1 | **installed #259; acceptance partial**: missing phone consumer and pinned enrollment implemented. Signed builds pass; real same-account enrollment pending | Fresh install connects with no code |
| 30 | Help / docs / website | 2 | **on device, both**: installed Mac Help and phone Settings → Guide render the live Counterpart Help page | counterpart.dtmont.com/help.html loads; Settings → Help opens it |
| 31 | No bed/plate checks anywhere | 3 | done (app + both MCPs) | — |
| 32 | Blender only while a pass runs | 1 | **installed #259/#265/#267; helper lifecycle observed**: real cleanup runs close their owned Blender and release port 9876. Installed Settings reports that Blender is set up and opens for cleanup; the AI connection test passes. #267 supplies official add-on status/repair with backup and alias preservation. Photo-overview candidate completed in 636 seconds, with original inputs and six live projects unchanged; geometry acceptance is separate | No Blender between jobs |
| 33 | CPU/RAM/GPU efficient | 2 | **background budget still fails**: installed Mac 1355 measures 347.9 MB open / 348.9 MB after closing the window, peak 590.9 MB, in potato → mic mount → Explore → idle. This is higher than the earlier 1227 sample (306 MB open / 307 MB closed). #284 clears the entity cache when hidden and avoids reloading retained stills, but does not achieve the 150 MB target. No efficiency completion claim; phone Instruments remains pending | Meets PRD §9.6 budgets |
| 34 | Don't fill the disk with garbage | 1 | **ongoing**: obsolete app bundles and owned build caches removed, including another 3.62 GiB of verified merged worktrees/caches in the latest cleanup; receipts and UI evidence retained; integrated source branches retired. User projects/captures and unrelated dirty work retained | Disk stays flat across builds |
| 35 | Credit authors (scan rig, published models) | 1 | in help page; app credit merged for published models | Credits shown in app |
| 36 | Scan rig (Kass 3D) in the app | 1 | **installed #259; acceptance partial**: Mac Help opens the credited Kass 3D rig page; phone About already carries the credit | Help → Print the scan rig opens the MakerWorld page |
| 37 | Use the Linux boxes for non-Apple work | 2 | done (#224, #226, stm-ci) | — |
| 38 | Versioning discipline, no overlapping writers | 1 | done (branch_check.py) | — |
| 39 | Real-world testing of the user experience | 1 | ongoing | Each fix tested on his devices |
| 40 | Second opinions (advisor, Codex) | 2 | **ongoing**: competing Claude executors stopped; tool-disabled Claude advice, independent integration review and GitHub reviews used | — |

## Current evidence and outstanding device checks

The combined workflow run at `7c6e09e1` passed the complete phone UI suite, Mac build, capture
lifecycle, packaging, contracts, printer handoff, pipeline and license jobs. Its two companion
fixture failures are corrected; both Node 22/24 companion workflows pass at `4d7c7b3f`.
Later review fixes pass 119 shared tests, 10 simulator AppTests, 25 Mac ObjectsModel tests and the
full native capture suite. Signed integration builds pass and are installed. Both Node 22/24 companion workflows also pass the final updater deadline fix at `3b8ea525`.
Hosted Actions cannot start because of the account billing restriction; no required checks are configured.

No new physical print, stop test, camera/Face ID acceptance, phone/Watch push receipt or fresh
same-account enrollment has been claimed. Build 1355 installed without reset; actual phone UI is verified: connected Home, model,
Project Settings, saved rename/defaults, and a real one-copy 44 min / 18 g / 272-layer print estimate.
No print was dispatched. OS notification authorization is enabled; this is not a delivery receipt. The Sandbox APNs relay is deployed but still requires credentials and delivery verification. These do not prevent
continued implementation and Mac acceptance work.

The latest exact-source checks passed: Node 22/24 companion workflows each 740 tests plus one
skip; Mac 142 tests plus one existing Keychain skip; shared Swift 153 tests; signed Mac and
phone Release builds. Actual phone 1355 Print Another again shows 44 min / 18 g / 272 layers,
P1S Ready and loaded AMS choices; canceled without dispatch. Deleting only the disposable
acceptance project while its phone detail was open now shows Project unavailable, and Back to
Projects returns to all six originals (#281). Phone search and Help are observed. Mirroring is
closed. Preservation receipt `after-1355-acceptance.json` equals `after-1355.json`.

## Scanning diagnosis (row 7)

- The walk-around scan uses Apple's `ObjectCaptureSession` on the phone.
- In-hand uses a hand-rolled `AVCaptureSession` RGB+LiDAR recorder (`HandheldCapture.swift`, `HandheldDepthRecorder.swift`). On the Mac it then goes through a custom pipeline: `tools/mac-reconstruct samples`, with Vision hand masks from `HandheldKit/ObjectMasker.swift`.

**Second opinion from Codex (gpt-6-astra, high, read-only):**
- Keep Apple's reconstruction. `PhotogrammetrySession` with `isObjectMaskingEnabled` explicitly supports turning the object between photos.
- First try a baseline: run `samples … --no-masks`, which keeps Apple's own masking.
- For production, capture sharp, overlapping still photos with depth and "turn, pause, capture" guidance, then drop the custom recorder and masker.

Defects Codex found in the code:
- 24 frames at 10 fps qualifies about 2.4 s of near-identical views.
- `ObjectMasker` clips beyond the nearest depth + 20 cm, so a nearer hand erases the object.
- `ObjectMasker` subtracts the hands before choosing the object.
- `reconstruct.ts` throws away the reconstruction's stderr, which hides the real error.

### AI provider routing acceptance — 2026-11-02

The new phone/Mac AI connection controls save and test ModelAccessService credentials.
They do not select the current ObjectService worker: cleanup, design and corrections still
use configured Claude Code. The UI now labels this diagnostic scope explicitly, and the
project footer reports the actual Claude worker rather than the unused saved choice.
Provider switching and globally disabling model AI remain unimplemented; no live provider
change or alternate-provider model job is claimed by this settings bridge.
