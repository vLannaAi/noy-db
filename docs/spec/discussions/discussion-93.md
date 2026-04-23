# Discussion #93 — Bundle adapter shape: a second adapter interface for blob-store backends (Drive, Dropbox, iCloud)

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/93

---

Every current adapter (`memory`, `file`, `s3`, `dynamo`, `browser`) implements the same 6-method `NoydbAdapter` interface, which assumes the backend is a **key-addressable record store**: `{compartment}/{collection}/{id}` resolves to one blob, and you can `get`/`put`/`delete`/`list` by that key. This shape fits S3, DynamoDB, filesystems, and IndexedDB trivially. It fits `Map` perfectly.

It does **not** fit consumer cloud storage — Google Drive, Dropbox, OneDrive, iCloud. All four share structural properties that punish per-record I/O:

1. **Opaque file IDs, not paths.** Every `get(path)` is really a metadata lookup + a body fetch. Path→id resolution is not O(1).
2. **Aggressive per-user rate limits.** Drive is ~12k requests/user/minute; Dropbox is ~600/minute for most endpoints. A cold `loadAll()` over a 5,000-record compartment trips both.
3. **No prefix streaming.** Listing returns metadata; bodies require N additional fetches.
4. **The user's mental model is "one file."** On Drive, the unit of share/move/delete/restore is a single file. Ten thousand invisible child records in an appDataFolder violate the abstraction users expect from "my Drive."

The right move is to **introduce a second adapter shape** — one that treats the entire compartment as a single blob — and implement consumer cloud adapters on top of it. This keeps the per-record adapters honest (S3 stays record-granular, because S3 genuinely is) while giving cloud-sync adapters an API that matches their physics.

## Proposed interface

```ts
export interface NoydbBundleAdapter {
  readonly name: string

  /** Fetch the current bundle blob + its opaque version token (ETag/rev/mtime). */
  pullBundle(handle: string): Promise<{
    bytes: Uint8Array
    version: string | null   // null when bundle doesn't exist yet
  } | null>

  /** Upload a new bundle. `expectedVersion` enables OCC against concurrent writers. */
  pushBundle(
    handle: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<{ version: string }>

  /** Cheap "has this changed?" check — HEAD-like, no body download. */
  headVersion(handle: string): Promise<string | null>

  /** Optional: adapter-native enumeration of available bundles. */
  listBundles?(): Promise<string[]>

  /** Optional liveness check. */
  ping?(): Promise<boolean>
}
```

Note: the interface keys on **bundle handle** (an opaque, library-generated identifier), not compartment name. See the `.noydb` container format discussion for why — exposing the compartment name in the remote filename leaks business identity.

Core wraps this in an **adapter shim** that satisfies the existing `NoydbAdapter` contract by mirroring the bundle into an in-memory `Map` on `loadAll` and flushing dirty state via debounced `pushBundle`:

```ts
export function bundleAdapter(bundle: NoydbBundleAdapter, opts?: BundleShimOptions): NoydbAdapter
```

That means **every existing consumer keeps working**. `Compartment`, `Collection`, query DSL, sync engine, Vue composables — none of them care whether their adapter is per-record or bundle-shimmed.

## What conflict resolution looks like

The bundle shim treats `expectedVersion` as the blob-level version returned by the backend, not the per-record `_v`. On a failed `pushBundle`:

1. Pull the latest bundle + version.
2. Re-run the existing sync engine's three-way merge (already handles per-record `_v` conflicts).
3. Retry `pushBundle` with the new version.
4. After N failed attempts (default 3, jittered backoff), surface `BundleConflictError` to the caller.

The per-record conflict machinery in `packages/core/src/sync.ts` stays untouched. The shim just re-runs it against a larger unit.

## Why this is worth doing in core, not per-adapter

- Every bundle adapter would otherwise reinvent: in-memory mirror, dirty tracking, debounce, compression, etag-based OCC, conflict-retry. ~300 lines of subtle code per adapter, and bugs in any of them silently corrupt user data.
- `compartment.dump()` already produces the exact payload a bundle adapter needs to write. Reusing it means bundle adapters inherit ledger integrity (v0.4) and keyring portability for free — no new wire format.
- The shim's debounce scheduler is generalizable back to record adapters (see sibling discussion on sync frequency), so building it here pays off twice.

## Open questions

1. **Where does the shim live?** `@noy-db/core` (so every consumer gets it for free) vs. a new `@noy-db/bundle` package. Leaning core because the code is small and the abstraction is orthogonal.
2. **Dirty tracking granularity.** Per-record dirty tracking is wasted on a bundle adapter because any change forces a full re-upload. Should the shim short-circuit the per-record dirty Map and just set a single `dirty: boolean`? Probably yes, with a config flag for visibility.
3. **`listBundles` semantics.** For Drive, this means listing `.noydb` files in a folder. For Dropbox, the equivalent. Worth standardizing the discovery pattern now so the three+ adapters that will share this shape stay consistent.
4. **Bundle size ceiling.** A 50K × 2KB compartment brotlis to ~40–60 MB. That's fine for Drive's per-file limit but painful for mobile uploads. Soft warn at 25 MB compressed, hard fail at 100 MB, steer users to Dynamo past that?

## Out of scope for this discussion

- The `.noydb` container format itself — sibling discussion.
- Google Drive specifics, OAuth flows, token storage — sibling discussion.
- Sync scheduling policy — sibling discussion.

This discussion is **only** about whether a second adapter shape belongs in core, and what its interface should be.


> _Comments are not archived here — see the URL for the full thread._
