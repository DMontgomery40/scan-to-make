# Local project store

Persists the shared FitSpec and its revision-bound preview/acceptance as private JSON records. This is a local worker library, with no HTTP listener or printer connection.

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
