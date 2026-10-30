# Detail stills

A phone scan is good at overall shape and bad at fine detail: ports, buttons,
seams, a figurine's face. A detail still is one close-up photo the user takes
of such an area and attaches to an existing retained capture. This package
supplies the data path only: contract, storage and HTTP. Comparing stills with
the mesh and fixing geometry is a later step; the mobile UI is separate.

The record is `@scan-to-make/contracts/detail-still`, schema id
`scan-to-make.detail-still/0.1`. It carries no region coordinates, masks or
taxonomy. An optional `label` is the user's own free text (at most 200
characters). `ordinal` is attachment order within the capture.

## Storage

`DetailStillStore` (`@scan-to-make/companion/detail-stills`) writes into the
capture's retained bundle:

```text
<capture directory>/<captureId>/detail-stills/<stillId>.img
<capture directory>/<captureId>/detail-stills/<stillId>.json
```

Bytes are written to synced temporary files, then renamed into place; the JSON
record rename is the commit point. Files use mode `0600` under a `0700`
directory. A still therefore survives a companion restart on the same storage.
Every operation runs under the same project lock as capture import and project
edits, and first checks the retained capture binding for the exact project and
revision. Downloads re-read the bytes and verify length, SHA-256 and sniffed
media type against the record before serving; a mismatch rejects.

Limits: at most 25 MiB per still (`MAX_DETAIL_STILL_BYTES`) and at most 24
stills per capture (`MAX_DETAIL_STILLS_PER_CAPTURE`). Only JPEG, HEIC and PNG
are accepted, decided by magic-byte sniffing, never by filename. Sniffing is
not image decoding or content validation.

## HTTP routes

The routes exist only on the authenticated private Serve listener with capture
storage enabled (`SCAN_TO_MAKE_CAPTURE_DIR`), the same mode as capture import.
They reuse the capture scopes: existing `pair-capture` devices already have
them. All routes require exactly one `projectRevision=N` query parameter and
the current project `If-Match` ETag, exactly like capture routes.

| Route | Scope | Input | Result |
|---|---|---|---|
| `POST /v1/saved-projects/:id/captures/:captureId/detail-stills?projectRevision=N[&label=...]` | `captures:import` | Raw image bytes; `Content-Type` one of `image/jpeg`, `image/heic`, `image/png` and matching the sniffed type | 201 `{still}` and the project ETag |
| `GET /v1/saved-projects/:id/captures/:captureId/detail-stills?projectRevision=N` | `captures:read` | — | `{captureId, stills}` in ordinal order |
| `GET /v1/saved-projects/:id/captures/:captureId/detail-stills/:stillId?projectRevision=N` | `captures:read` | — | Exact bytes, media type, `Content-Length` and `X-Content-SHA256` |
| `DELETE /v1/saved-projects/:id/captures/:captureId/detail-stills/:stillId?projectRevision=N` | `captures:import` | — | `{captureId, stillId, deleted: true}` |

`label` is URL-encoded free text, at most 200 characters. Bodies have the same
five-second deadline as capture import and share the single project/capture
request slot; a concurrent request receives 429. Authorization is rechecked
after upload and immediately before commit or download. Deleting a still
removes its record and bytes; remaining ordinals are unchanged, so gaps are
normal. The next upload takes one more than the highest ordinal ever assigned
for that capture. A per-capture high-water mark persists across deletions, so
deleting the newest still or every still never rewinds attachment order.

Errors keep the `{error: {code, message}}` shape:

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid-still` / `invalid-request` | Bad label, bad revision or bad ids |
| 401 | `unauthorized` | Rejected or revoked credential |
| 403 | `forbidden` | Wrong scope or Serve identity |
| 404 | `not-found` | Unknown capture or still, or routes not configured |
| 409 | `still-limit` | The capture already has 24 stills |
| 412 | `precondition-failed` | Stale ETag or project revision |
| 413 | `payload-too-large` | Still over 25 MiB |
| 415 | `unsupported-media-type` | Not JPEG/HEIC/PNG, or declared type differs from sniffed bytes |
| 422 | `still-unavailable` | Retained record or bytes fail verification |
| 428 | `precondition-required` | Missing `If-Match` |
| 429 | `busy` | Another snapshot/capture request is active |

Upload POST has no automatic retry guarantee: publication is the commit point,
so a lost response may follow a committed still. On an ambiguous result, list
the capture's stills before retrying.
