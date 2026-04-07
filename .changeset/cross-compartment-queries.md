---
"@noy-db/core": minor
"@noy-db/memory": minor
"@noy-db/file": minor
---

Cross-compartment role-scoped queries — `Noydb.listAccessibleCompartments()` and `Noydb.queryAcross()` (closes #63).

A single principal commonly holds grants across many compartments (multi-tenant apps, multi-project setups, multi-workspace tools). Until v0.5 there was no way to enumerate "every compartment my keyring can unlock at role X" or to fan a callback out across them — consumers had to track the compartment list out of band, which duplicates authorization state the library already owns and breaks zero-knowledge as soon as the index leaks.

### `Noydb.listAccessibleCompartments(options?)`

```ts
// All compartments I can unlock
const all = await db.listAccessibleCompartments()
// → [{ id: 'T1', role: 'owner' }, { id: 'T7', role: 'admin' }, ...]

// Only compartments where I'm at least admin
const admin = await db.listAccessibleCompartments({ minRole: 'admin' })
```

The walk asks the adapter for the compartment universe, then for each compartment attempts to load the calling user's keyring with the in-memory passphrase. Compartments where the user has no keyring file (`NoAccessError`) or where the passphrase doesn't unwrap the wrapped DEKs (`InvalidKeyError`) are silently dropped — **the existence of those compartments is never confirmed in the return value**.

`minRole` filters by privilege rank: `client (1) < viewer (2) < operator (3) < admin (4) < owner (5)`. The default `'client'` returns every accessible compartment.

A small performance bonus: every compartment whose keyring is successfully unwrapped during the probe is opportunistically primed in the keyring cache, so a subsequent `openCompartment(id)` against any of those compartments doesn't have to re-derive the KEK.

### `Noydb.queryAcross(ids, fn, options?)`

```ts
const results = await db.queryAcross(
  accessible.map((c) => c.id),
  async (comp) => {
    return comp.collection<Invoice>('invoices').query()
      .where('month', '==', '2026-03')
      .toArray()
  },
  { concurrency: 4 }, // default 1 — bump for cloud adapters
)
// results: Array<{ compartment, result?: Invoice[], error?: Error }>
```

Pure orchestration over `openCompartment()` — no new crypto, no new sync, no new authorization layer. Per-compartment errors are captured into the result slot and **do not abort the fan-out** — if one compartment's callback throws, that compartment's slot carries the error and the remaining compartments still run.

**Concurrency** is opt-in via `options.concurrency`. The default is `1` (sequential) — conservative because per-compartment callbacks typically do their own I/O and an unbounded fan-out can exhaust adapter connections (DynamoDB throughput, S3 socket limits, browser fetch concurrency). The implementation uses a tiny inline p-limit-style scheduler — no external dep — that maintains a sliding window of `concurrency` in-flight tasks and preserves caller-supplied result order regardless of completion order.

### Composes with `exportStream()` for cross-compartment plaintext export

```ts
const accessible = await db.listAccessibleCompartments({ minRole: 'admin' })
const exports = await db.queryAcross(
  accessible.map((c) => c.id),
  async (comp) => {
    const out: unknown[] = []
    for await (const chunk of comp.exportStream()) out.push(chunk)
    return out
  },
)
```

This is one of the load-bearing reasons `exportStream()` lives in core: the moment you have both primitives, the cross-compartment plaintext export story falls out without any new code.

### Adapter contract change — new optional 7th method

```ts
interface NoydbAdapter {
  // ... 6 mandatory methods unchanged
  listCompartments?(): Promise<string[]>
}
```

Returns the names of every top-level compartment the adapter currently stores. The 6-method core contract is unchanged; this is an additive optional extension discovered via `'listCompartments' in adapter`, the same pattern as `listPage`.

**Implemented in this release:**

- **`@noy-db/memory`** — `[...store.keys()]`, O(compartments)
- **`@noy-db/file`** — `readdir(dir)` filtered to entries that are themselves directories (skips top-level files like README, .DS_Store)

**Not implemented in v0.5:**

- `@noy-db/browser` — could scan localStorage prefixes, not done yet
- `@noy-db/dynamo` — needs a GSI on the compartment partition key, consumer-provisioned
- `@noy-db/s3` — needs `s3:ListBucket` permission with the noy-db prefix

Calling `listAccessibleCompartments()` against an adapter that doesn't implement `listCompartments` throws the new `AdapterCapabilityError` with a clear message naming the missing capability and the calling API. Consumers using cloud adapters can either provision the GSI/permission themselves and ship their own adapter wrapper, or maintain the candidate compartment list out of band and pass it directly to `queryAcross()`.

### New error class — `AdapterCapabilityError`

```ts
import { AdapterCapabilityError } from '@noy-db/core'

try {
  await db.listAccessibleCompartments()
} catch (e) {
  if (e instanceof AdapterCapabilityError) {
    console.error(`Adapter missing capability: ${e.capability}`)
    // → "Adapter missing capability: listCompartments"
  }
}
```

Distinct from `ValidationError` because the diagnostic shape is different: `ValidationError` says "the inputs you passed are wrong"; `AdapterCapabilityError` says "the inputs are fine, but the adapter you wired up doesn't support what you're asking for." Different fix, different documentation.

### New types in the public API

- `AccessibleCompartment` — `{ id: string; role: Role }`
- `ListAccessibleCompartmentsOptions` — `{ minRole?: Role }`
- `QueryAcrossOptions` — `{ concurrency?: number }`
- `QueryAcrossResult<T>` — discriminated union of `{ compartment, result }` and `{ compartment, error }`

### Known v0.4 edge case (documented, not fixed in this release)

A compartment whose keyring file happens to have an empty wrapped-DEKs map (because the owner granted access *before* any collection was created) will pass the `loadKeyring` probe with **any** passphrase — there are no DEKs to unwrap, so the integrity-checked unwrap that normally rejects wrong passphrases never runs.

The result: an unrelated principal who happens to know the user-id and the compartment name can show up in `listAccessibleCompartments()` as having access to that empty compartment. They cannot read any actual data (their DEK set is empty), so this is a metadata leak (compartment name + user-id), **not a content leak**. Hardening this via a passphrase canary in the keyring file format is tracked as a v0.6+ follow-up. The limitation is documented in the `listAccessibleCompartments()` JSDoc.

### Tests

- **Core (12 new tests in `cross-compartment.test.ts`):** enumeration with default minRole, minRole filtering, existence-leak guarantee against compartments alice has no keyring for, wrong-passphrase rejection, `AdapterCapabilityError` against an adapter missing the capability, `queryAcross` fan-out and result tagging, caller-supplied order preserved under concurrency > 1, per-compartment errors don't abort siblings, concurrency timing observable, empty compartment list, composition with `exportStream()`.
- **Memory adapter (6 new tests):** capability presence, fresh adapter empty, single put creates one compartment, multi-compartment enumeration, idempotent across collections/records, collection-vs-compartment distinction.
- **File adapter (6 new tests):** capability presence, empty directory, missing directory returns empty array, single put creates the tree, multi-compartment enumeration, top-level files (README, .DS_Store) are skipped.

Full monorepo suite: 720 tests passing.

### Documentation updated

- `packages/core/README.md` — new "Cross-compartment queries" section above the "Backup and export" section.
- `NOYDB_SPEC.md` — new v0.5 #63 paragraph in the Roles section explaining the two methods, the existence-leak guarantee, and the adapter capability requirement.
- `docs/adapters.md` — new `listCompartments` capability section with the adapter support matrix and the privacy note.

Part of v0.5.0.
