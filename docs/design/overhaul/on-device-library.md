# The phone's own library

David, Nov 11, on the app showing nothing, or "your Mac isn't answering", for projects he had just looked at: "You know phones can store things right? … to say the phone app can only show images with the Mac is insane. Just keep the latest versions on the phone? Or in iCloud? They literally connect over iCloud that's how they find each other. Or for android Linux peooole maybe just let them (and iPhone people all people) just choose? Doesn't seem hard. Never seen app in my life, since 2009 or so, struggle showing images it just had, 10 minutes later, because of a dependency on some Mac mini someeheee".

His phone reaches his Mac through WireGuard from cellular most of the day (board X100), so a slow or absent Mac is the ordinary case, not the bad day.

## What was wrong

- Pictures and models lived in `Library/Caches/Objects/<project>/<version>/`. iOS empties Caches whenever it wants space ("Optimizing Your App's Data for iCloud Backup": the system periodically purges `Caches`).
- A file was fetched only when a screen asked for it, keyed by the project's version. A project never opened had nothing; a project whose version moved on while the Mac was away had nothing for the new version, and the stage said "The picture didn't come from your Mac".
- A new version landing deleted every older version folder of the project, the model included.

## What the phone does now

**One library per paired Mac, owned by the phone** (`OnDeviceLibrary`, CounterpartKit; Android `api/OnDeviceLibrary.kt`).

- *Where.* iPhone and iPad: `Application Support/Counterpart/Library/<hash of the Mac>/`. Apple's guidance is to keep support files the app needs in Application Support, and to exclude from backup anything the app can download again, by setting `isExcludedFromBackup` on the directory ("Using the file system effectively"; "Optimizing Your App's Data for iCloud Backup"; `URLResourceKey.isExcludedFromBackupKey`, which some file operations reset, so it is set again after writes). Files are `FileProtectionType.completeUntilFirstUserAuthentication`: unreadable until the first unlock after a restart, then readable while locked, so the background fill and a Live Activity's picture work with the phone in a pocket ("Encrypting Your App's Files"). Android: `noBackupFilesDir/Library`, app-private, outside Auto Backup, never cleared by the system as `cacheDir` can be.
- *What.* One file per project path (`pictures/part-….png`, `model.stl`, `asks/<id>.jpg`, `scan/phone-preview.usdz`), the newest version the phone has. An index (`index.json`) records each file's version, size, kind (picture, model, scan) and when its project was last opened.
- *Reading.* Every screen draws the kept copy at once, with no network and no Keychain read: Home's cards, the project stage (`StagePicture` reports it as *shown*, never *loading*, so no spinner sits over a picture the phone has), the question's photo and the 3D model. The Mac is asked only for the current version; the project list says whether one exists.
- *Replacing.* A newer file is written beside the old one under its own name and replaces it only once it has fully arrived; then that one file's older copy goes. A slow download of an older version that finishes late never overwrites a newer one. Another file of the project (its model, another picture) is never touched.
- *Refusals.* A file the Mac refuses as too large (`413 file-too-large`) is remembered by version and not asked for again.

**It fills itself.** When the project list loads or changes (`LibraryFiller`, Android `LibraryFill`):

| What | When | On which link |
|---|---|---|
| Every project's pictures: its card picture and its stage pictures (`picture`, `pictures{}`) | every list | any |
| Plate pictures and an open question's photo | projects whose page has been opened | any |
| The 3D model (`model.stl`) | opened projects and the three most recently changed | unmetered only, unless the page asks |
| The scan model (`phone-preview.usdz` when the Mac lists it, else the scan, never over 64 MB) | opened projects, only when the person keeps everything | unmetered; on a metered link only when listed under 25 MB |

Three files at a time. A new list adds to what is being fetched and never cancels a file in flight (the event stream reloads the list often on a slow link); the ceiling is enforced each time the queue drains. "Metered": iOS `NWPath.isExpensive` (cellular, a personal hotspot) or `isConstrained` (Low Data Mode); Apple asks apps to put off discretionary transfers on those links (`URLRequest.allowsExpensiveNetworkAccess`, `allowsConstrainedNetworkAccess`). Android: the active network lacks `NET_CAPABILITY_NOT_METERED`. A page's own request always fetches what it shows, on any link. **Not verified:** whether iOS reports the path under David's WireGuard tunnel as expensive when the phone is on cellular. If it does not, models also fill over cellular there; the rule is still right for everyone else.

**The person chooses.** Settings → *Keep on this iPhone* (iPad, phone):

| Choice | Keeps | Ceiling | David's 20 projects (the screenshot tool's copy, Nov 10) |
|---|---|---|---|
| Pictures only | every picture | 200 MB | 10.2 MB |
| Pictures and 3D models (default) | and the models | 500 MB | 65.7 MB if every model were kept; the fill keeps opened and recent ones |
| Everything, scans included | and the scans the phone may fetch | 2 GB | 98.1 MB |

Measured on the iPhone simulator after one normal run of the screenshot tool over that copy, with no project page opened: the default choice had filled 28 pictures for all 20 projects (10.7 MB) and the 3 most recent projects' models (1.5 MB), 12.2 MB in all. A line says how much space it uses, with Clear. Past the ceiling, scans go first, then models, then pictures, each from the project opened longest ago. Choosing a smaller option lets go of what it no longer keeps at once.

**It forgets.** A project no longer in the Mac's list loses its files. Pairing another Mac clears the old Mac's library; Forget This Mac clears all of it. Nothing else does: a pairing that could not be read (a locked phone's Keychain), or a Mac that wants pairing again, changes nothing. Board X96 found exactly that read reported as "pairing changed", and clearing on it would repeat that defect.

### Every layout

- **iPhone and iPad**: the same code.
- **Android**: the same library, fill and setting (above). Before this it kept files in `cacheDir/Objects` per version and decoded them into a 48 MB in-memory cache; the card and the stage now draw the kept copy first.
- **Mac**: nothing to do. The Mac app reads the companion's project folders on the same disk.
- **Linux**: nothing to do. It talks to a companion on the same machine over its control socket and reads project files from that machine's disk (`apps/linux/src-tauri/src/main.rs`, `project_file` and `read_scoped`).

### Tests

CounterpartKit `OnDeviceLibraryTests` (the index across a relaunch, backup exclusion, replacement after arrival through the client with the Mac away, one file replaced without the others, too-large remembered, kinds not kept, eviction order, pruning, unpairing and another Mac, Clear, what the fill wants and the link rules). Android `OnDeviceLibraryTests`, the same cases. UI tests `OnDeviceLibraryUITests`: the list loads and the library fills with no page opened; the link drops; the app relaunches; Home has the projects and every project page's stage shows its picture (`shown`); and past a ceiling, models are evicted and every picture stays. `LayoutParityUITests` reaches the setting with projects present. `scripts/ux_screens.py --keep-app-data` keeps the app's data between runs, so `--condition away` shows what a normal run filled.

## Never twice (issue #720)

David, Nov 11, 19:12Z: "if i just saw it 2 seconds ago, how is it having to come from my mac again?" A project's version (`mediaVersion`) moves with every completed pass, but most of its files don't change. Before, a new version meant every file was fetched and decoded again, each on a new TLS session.

- **The Mac tags every project file by its bytes.** The tag is an `ETag`, the SHA-256 of the bytes, remembered per file identity (`services/companion/src/objects/http.ts`, `fileTag`). It covers the model, originals, scans, photos, captures, renders, pictures, the question's photo and print frames. A request whose `If-None-Match` holds that tag is answered `304` with nothing sent.
- **The phone asks with the tag it has.** For a newer version of a file it keeps, the library sends the tag from the kept copy's entry. On `304` the kept file becomes that version's under the same name on disk, so the mesh and still already drawn from that URL are reused. A file the library doesn't keep (a scan under "Pictures and 3D models") carries its tag beside it in Caches, `<file>.etag`. An older version's cached copy goes one file at a time, never the whole folder.
- **A Mac picture is named by what it draws** (`pictures/<role>-<files>-<drawing>.png`, the companion's `pictureName`). The library, the decoded-picture memory and the card and stage keys use the name alone, so a newer version neither asks nor decodes it again.
- **"Coming from your Mac" is only for what the phone has never had, or what changed.** While the phone decodes a picture it keeps (a few milliseconds), the stage is bare. While a newer copy comes, the stage shows the last one decoded.
- **One connection.** The paired Mac's file downloads share one `URLSession` per pin and address (`SessionPool`, `Transport.swift`). They ride its open TLS connection, and each task's delegate still checks the pin: with no session delegate, URLSession hands the server-trust challenge to the task's delegate (Apple, `URLSessionTaskDelegate.urlSession(_:task:didReceive:completionHandler:)`). The media trace records `request.connection reused=` from `URLSessionTaskTransactionMetrics.isReusedConnection`.
- **The same Mac stays the same Mac.** The saved list and the library are keyed by the Mac's pin, including while its credential is expired. A Keychain read that failed never clears them; only Forget or a different Mac does (audit row 6, X115).

## iCloud: not built here

The lead decides from this section.

**What exists.** The Mac already writes a `CounterpartProject` record per project into the person's private database (container `iCloud.com.scantomake.counterpart`, custom zone; `docs/protocols/cloudkit.md`, `apps/mac/App/CloudSync.swift`). It carries title, state, the open question and print progress, and a `thumbnail` asset: the project's picture as a 640-pixel JPEG, uploaded only when it changes. The phone already reads those records (`MobileCloud.readChanges`) to find the Mac and for print updates, but asks only for their text keys. The notification service reads `thumbnail` for a notification's picture. Production and Sandbox are separate environments: a TestFlight or App Store phone reads Production, a development build Sandbox, and the Mac must write to the same one (`docs/distribution.md`).

**What showing pictures from iCloud would take.**
1. The phone adds `thumbnail` to the keys it reads from `CounterpartProject` (only when the record's picture changed: compare a version field the Mac already keeps, or `modificationDate`), and commits the asset's file into the library as that project's card picture. CloudKit stages fetched assets in a folder the system cleans up, so the file has to be moved into the library at once (`CKAsset.fileURL`). About a day: no Mac change, no schema change.
2. The stage's own pictures (`pictures.part`, `.scan`, `.together`) and plate pictures would need new asset fields or a child record per picture. That is a schema change, deployed to Production before any build uses it.
3. A model as an asset: up to 12 MB per project on David's set, uploaded at every new version.

**Cost in the person's iCloud storage.** Private-database records and assets count against the person's own iCloud quota (`CKDatabase.Scope.private`; a full quota fails the save with `CKError.quotaExceeded`). The thumbnail is about 50–150 KB per project: 1–3 MB for David's 20. Stage pictures at their full size add about 10 MB. Models add about 55 MB, and every new version is uploaded again (CloudKit deletes orphaned assets later). On a free 5 GB plan, models are not a fair thing to take without asking.

**Android and Linux.** No iCloud. Linux needs nothing (above). Android has only the Mac and its own library; an Android-reachable equivalent would be a server we run, which this project does not have, or the person's own Google Drive, a second sync system to keep correct. Neither is worth it for pictures the phone already keeps.

**Recommendation.** Do step 1 only, in a later PR: the thumbnail is already in iCloud and already paid for, so a phone that was never near the Mac (a new phone, a reinstall, a project made while the phone was off) gets every card picture from iCloud with no Mac, at no new cost. Do not put stage pictures or models in iCloud now: the on-device library already covers "images it just had", which is what David asked for, and models in iCloud would charge his storage for something the phone can keep itself.
