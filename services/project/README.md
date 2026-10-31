# Saved-project storage

Filesystem storage and conditional sync for the portable saved-project format in `@scan-to-make/contracts/saved-project`. The companion uses it to hold the phone's projects next to their captures. This is a local library, with no HTTP listener of its own.

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/project --ignore-scripts
npm test --prefix services/project
```

## Portable saved projects

`FileSavedProjectStorage` implements the shared `SavedProjectStorage` byte interface for the native portable project format. Pair it with the portable transitions:

```ts
import { FileSavedProjectStorage } from '@scan-to-make/project';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';

const projects = createSavedProjects(new FileSavedProjectStorage('/private/local/saved-projects'));
await projects.create({ id: 'lamp', brief: { object: 'Desk lamp', context: '', addition: '' } });
const reopened = await projects.load('lamp');
```

Use a dedicated trusted local directory. Record and lock names use reversible lowercase base32, preserving case-distinct IDs on case-insensitive filesystems. Reads retain exact UTF-8 text, including a leading BOM, and compare-and-swap compares that exact text, including whitespace. Invalid UTF-8 and oversized records fail; corrupt/future project JSON remains available for the portable decoder to report without repair. The default limit is 4MiB per record, configurable up to64MiB. Artifact bytes belong in a separate bounded ingestion store.

The exclusive directory lock covers comparison, temporary-file flush and atomic replacement across cooperating processes. A parent-directory flush follows rename. Contention fails visibly. An abandoned lock is never removed automatically: an operator first confirms no writer remains and inspects the record and any leftover temporary files, then removes that lock. A storage error after rename may mean the replacement already happened: reread and reconcile instead of blindly retrying. This is a local-filesystem adapter, not a distributed database or a guarantee against every power-loss scenario. It adds no HTTP route, authentication grant, capture import or print authorization.

`SavedProjectSync` adds ETag-conditioned reads and writes of exact snapshot bytes. The companion's `/v1/saved-projects/:id` routes use it.
