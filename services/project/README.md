# Local project store

Persists the shared discriminated ProjectFitSpec and its revision-bound preview/acceptance as private JSON records. This is a local worker library, with no HTTP listener or printer connection.

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/project --ignore-scripts
npm test --prefix services/project
```

Create `new ProjectStore(directory)` with a trusted, private local directory. Project IDs are restricted to ASCII letters, numbers, hyphens and underscores (1–128 characters, first character alphanumeric). The service does not store camera captures, credentials or artifact bytes.

- `create(spec)` validates the complete spec, requires revision zero and never overwrites an existing project.
- `load(id)` validates persisted data on every read. A new store instance reloads the same spec and acceptance after an app/service restart. Malformed JSON, stale artifact revisions and file/spec identity mismatches fail visibly.
- `applyPatch(id, patch)` uses the shared expected-revision/protected-interface rules. Any effective spec edit clears its preview and acceptance. A no-op preserves both.
- `attachPreview(id, expectedRevision, artifact)` rejects a stale receipt and records the validated artifact identity for that exact revision. Replacing a preview clears acceptance.
- `acceptPreview(id, expectedRevision, artifact)` requires the exact current revision, digest, media type and byte length, then persists acceptance.

Preview acceptance is a design-review record, not authorization to print. Callers must authenticate the actor, enforce genuine measurement provenance and human interface-edit authorization, confirm that worker output belongs to the submitted spec, verify the exact artifact bytes, and perform independent geometry/print checks. The library cannot infer these facts from IDs or hashes supplied by a caller.

Writes use an exclusive per-project directory lock shared across store instances/processes, a unique private temporary file, file flush, and atomic rename (or an exclusive hard link for creation). Readers see a whole old or new record. Record files are created with mode 0600 and new store/lock directories with mode 0700. Existing directory permissions are not changed. Use a local filesystem that supports atomic same-directory rename and hard links; this is not a distributed/network-filesystem database or a power-loss durability guarantee.

If a process dies while holding the lock, further writes fail with an interrupted-write/busy error. Do not automatically delete locks or blindly retry. An operator must first verify that no writer remains, inspect the current record and leftover temporary files, then recover that specific lock. Reads remain available. This first version intentionally prefers a visible recovery step to potentially overwriting another writer.


## Template boundary

The same `create`, `load`, `applyPatch`, `attachPreview` and `acceptPreview` operations accept both supported variants through `ProjectFitSpecSchema`. Existing cup-holder records stay byte/schema compatible and require no eager migration; drawer-tray records carry schema `0.2.0` inside the existing project-record envelope. Callers narrow `record.spec.template` before using dimensions. Drawer patches carry `template: 'drawer-tray'`; a patch cannot change a saved project's template.

A drawer divider edit invalidates the revision-bound preview/acceptance even if its prior outer-envelope fit observation remains applicable. Unauthorized or cross-template writes leave persisted bytes untouched. File locking, exact artifact identity and restart/reload rules apply equally to both templates. This is the stable local library boundary for a future mobile transport; it does not itself add an HTTP endpoint, credentials or app-relaunch persistence to the mobile UI.

## Mobile saved-project boundary

The portable `@scan-to-make/contracts/saved-project` subpath now supplies a general brief plus optional measured fit, strict revision-aware changes and a repository over a platform-provided atomic storage interface. Native clients should use that boundary rather than importing this Node filesystem implementation. Its `SavedProject` envelope is distinct from this service's `ProjectRecord` (which also tracks preview acceptance); use separate storage namespaces. There is no implicit migration, network synchronization, preview-acceptance transfer or native-storage implementation in either API. See the contracts README for exact consumer operations, conflict outcomes and adapter obligations.
