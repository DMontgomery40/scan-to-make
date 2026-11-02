# Fusion document binding

A design pass previously opened a new document, discarded its identity, and sent later
modeling/export calls to whichever Fusion tab was active. The companion lock serialized
Counterpart jobs but could not prevent the person switching tabs. A revision also asked
the worker to open its previous F3D, without a document contract.

The bounded fix uses the configured printer transport, including localhost SSH:

- The Fusion add-in creates a new document, or imports the project's F3D into a new
  document, and returns an opaque session token tied to that exact document reference.
  Names are not identities; Autodesk also documents that copied documents can share a
  `creationId`. The previous active document is restored without saving or closing it.
- Each bound request resolves that token inside the Fusion main-thread handler, activates
  the target, uses its explicit Design/CAM references, and restores the previous document
  in `finally`. Missing/closed tokens fail before operations. Handler event pumping
  reactivates the target before subsequent global UI operations. Handler restarts discard
  bindings; dispatch maps belong to each instance.
- Bambu forwards the token to every modeling and export subcall. The TCP client verifies
  add-in binding support on the same connection before a bound operation; an older add-in
  cannot silently ignore the new envelope field. Unbound external clients remain compatible.
- The app saves the returned token in a private pass configuration and starts a small SDK
  stdio adapter. It injects the binding into calls over the unchanged configured transport,
  so it also works with forced SSH commands. Worker arguments cannot replace the token.
  An old bridge is rejected before new-document dispatch and the existing engine fallback
  records the reason. No token is selected by the worker prompt.
- A completed pass closes only its bound document after the runner validates both final
  STL and F3D artifacts. Failed/capped/incomplete work stays open for recovery. A failed
  close leaves the completed artifacts and result intact.
- Existing arbitrary `execute_code` remains a trusted Python capability, not a sandbox.
  Its supplied `design`, `component`, `document`, and application context are bound;
  explicitly reacquiring global Autodesk APIs is outside that contextual guarantee.

The upstream `new_document` uses Autodesk's `Documents.add` or
[`ImportManager.importToNewDocument`](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/core_ImportManager_importToNewDocument.htm),
which returns a separate unnamed, unsaved document. The token avoids the documented
[`creationId` copy collision](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/core_Document_creationId.htm).
`close_document` can close only a document created by this add-in session and explicitly
bound by the caller; it supports bounded acceptance cleanup without touching user documents.

Source verification covers switched tabs, missing/closed tokens, handler exceptions and
restart, distinct copied-document identities, revision import, legacy capability refusal,
all four export subcalls, worker override rejection, actual stdio forwarding and EOF cleanup.
Source tests use isolated fixtures. Private integration has a verified original add-in
backup and exact source/package hashes. Early private attempts reached the old handler and rejected `new_document` before creating
any document; original documents still matched their baseline. The startup fix reloads only
the add-in's own modules in dependency order and has a two-run import-cache regression.
A path-checked refresh loaded the new implementation modules without touching documents;
private acceptance still needs a confirmed restart of the add-in's handler instance.

Installed printer transport, profile/environment and public packages remain unchanged.
Mac Set Up now pins the reviewed fork commit `86a3016a5a5b4a705228acc2f3b75aff7dcfd758` and verifies all ten add-in files, so running it later cannot
restore the older unbound bridge. Real-pass acceptance remains pending: take a fresh read-only baseline after the
user job ends, create one owned tiny model, export through production APIs, close only that
test document, and verify the original documents. Only then run a private production pass.
The private runtime and installed configured CLI still require the reviewed local integration
plan before real installed passes can use this capability. Receipts and backups are under
`~/scan-to-make-work/codex-fusion-acceptance-20261102`.
