# Issue #229 — refactor(hub): subpath exports — additive opt-in for hub/store, hub/i18n, hub/team, hub/session, hub/ledger, hub/query

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Add subpath exports to @noy-db/hub package.json without removing anything from the main-entry barrel. Consumers can then write:

```ts
import { createNoydb } from "@noy-db/hub"              // same as today
import { dictKey } from "@noy-db/hub/i18n"             // new, tree-shakes better
import { grant, SyncTarget } from "@noy-db/hub/team"   // new
import { routeStore, wrapStore } from "@noy-db/hub/store" // new
```

No breaking change for the 3 pilot adopters. Depends on the per-subpath file-move issues below being done first so the subpath index files exist to re-export.
