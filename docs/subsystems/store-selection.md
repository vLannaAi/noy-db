# Platform-adaptive store selection

> **Decision (#797): this stays app territory. The hub ships no `pickStore()` helper.**
>
> Recorded here rather than left implicit, because "can noy-db route to a different store per
> platform?" is asked often enough that the *absence* of a helper needs a stated reason.

## Why no helper

A `pickStore()` in the hub would have to know about the `to-*` packages to choose between them —
either importing them (a dependency graph the one-way seam law forbids: the hub may never import a
satellite) or taking them as arguments, at which point it is the conditional you already wrote, with
a function call around it.

It would also be the hub's only API aware of satellite packages, and it would sit on the always-on
floor, which the bundle gate exists to keep at ~490 B gz.

Environment detection is genuinely the app's job: it depends on bundler targets, SSR, React Native,
Electron main-vs-renderer, and test environments — things the hub cannot see and should not guess.

## The pattern

Every `to-*` factory returns the same `NoydbStore` contract, so choosing one is a plain conditional
at construction time:

```ts
import { createNoydb } from '@noy-db/hub'
import { toBrowserIdb } from '@noy-db/to-browser-idb'
import { toFile } from '@noy-db/to-file'

const store =
  typeof indexedDB !== 'undefined'
    ? toBrowserIdb()
    : toFile({ dir: './data' })

const db = await createNoydb({ store, user, secret })
```

Prefer feature detection (`typeof indexedDB !== 'undefined'`) over platform sniffing — it survives
bundling, SSR and test environments, where `process.platform` does not.

### Multi-store topologies

Two composition seams, both documented in [`SERVICES.md`](../../SERVICES.md):

- **`routeStore()`** multiplexes one handle across many backends by rule — per collection, per vault
  prefix, blobs to object storage, age-based cold tiering, quota overflow. It returns a
  `RoutedNoydbStore`, which is a real store plus a runtime control surface (`override`, `suspend`,
  `compact`), so routes can be swapped or suspended without rebuilding the instance.
- **`withSync({ sync: [...] })`** takes a primary remote or an array of `{ store, role }` targets, so
  "local platform store + cloud replica" is expressible per platform.

They nest freely — you can meter a routed store, or route to metered stores:

```ts
const pg = toMeter(toPostgres({ … }))
const s3 = toMeter(toAwsS3({ … }))
const store = routeStore({ default: pg, blobs: s3 })
```

## The platform matrix, honestly

| Platform | Store | Status |
|---|---|---|
| Browser | `@noy-db/to-browser-idb` | ships |
| Node / Electron main / CLI | `@noy-db/to-file` | ships |
| Tests, REPL, hot cache | `@noy-db/to-memory` | ships |
| SQL / cloud / remote FS | the `noy-db-to` family | ships |
| macOS (Node) | `@noy-db/to-icloud` | ships — but see below |
| **iOS / iPadOS** | **`to-cloudkit`** | **not shipped** — [noy-db-to#16](https://github.com/vLannaAi/noy-db-to/issues/16) |

**The Apple gap is real and worth stating before you build on it.** `to-icloud` is Node-on-macOS
only: it works against the iCloud Drive folder through the filesystem. iOS and iPadOS have no such
folder access, so they need CloudKit, which is deferred. Until `to-cloudkit` ships, an
iOS target has no first-party Apple-native store — use a cloud store from the `noy-db-to` family, or
`to-browser-idb` inside a web view.

Also note [noy-db-to#15](https://github.com/vLannaAi/noy-db-to/issues/15): modern macOS evicts to
APFS dataless files rather than `.icloud` stubs, so `to-icloud`'s eviction detection is
macOS-version-sensitive.

## See also

- [`SERVICES.md`](../../SERVICES.md) — the store contract, `routeStore`'s routing axes, and the
  `to<Backend>()` naming rule
- Consumer-facing recipes live in
  [noy-db-docs](https://github.com/vLannaAi/noy-db-docs) — this page is the internal decision record
