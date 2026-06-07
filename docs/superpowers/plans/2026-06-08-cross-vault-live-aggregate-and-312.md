# Cross-Vault Live + Aggregate + #312 Forward-Compat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VaultGroup fan-out key-custody-neutral (#312 A+B), add the `Reducer.merge` protocol seam (#312 E), and implement the reactive `queryAcrossLive` + distributed `aggregateAcross`/`aggregateAcrossLive` surface on `ShardedQuery`.

**Architecture:** Phase 1 adds a no-create open mode so a non-granted fan-out open fails cleanly (and is classified `'no-grant'`) instead of self-provisioning — these are small core touches plus federation wiring, landing on the MVP base. Phase 2 adds optional `Reducer.merge`. Phase 3 builds one reactive core (`CrossVaultLive<S>`, single-flight + debounce + `ready`) with two `LiveQuery`/`LiveAggregation`-shaped facades, plus central-reduce aggregate wrappers, all in the lazy `federation/` chunk.

**Tech Stack:** TypeScript, `@noy-db/hub` internals (`Noydb`, `Vault`, `Collection`, `queryAcross`, `reduceRecords`/`groupAndReduce`, `LiveQuery`/`LiveAggregation`), Vitest. pnpm 9.

**Spec:** `docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md` (revised for #312).

**Branching/sequencing:** Phase 1 (A+B) on the MVP base (branch `feat/m16-mvf-vaultgroup-routing`, PR #292) — land before the `reason` union ossifies. Then **rebase** `feat/m16-cross-vault-live-aggregate` onto it. Phase 2 + Phase 3 on `feat/m16-cross-vault-live-aggregate`. Run tests with `pnpm --filter @noy-db/hub exec vitest run <file>`.

**Verified current state (rely on these):**
- `SkippedVault.reason` = `'schema-drift' | 'error'` (`federation/types.ts`).
- `ShardedQuery.toArray` (`federation/vault-group.ts`) inlines: minVersion skip → `Promise.all(_shardVaultProvisioned)` guard → `queryAcross(ids, fn, {concurrency})` → fold `r.error` into `{reason:'error'}`.
- `openVault(name, opts?: { locale?: string })` → `getKeyringInternal(vault)`; catch: `if (err instanceof NoAccessError) { keyring = await createOwnerKeyring(...) }` (noydb.ts ~2747).
- `loadKeyring` throws `NoAccessError` when `_keyring/<userId>` is absent (no other-principal check).
- `queryAcross<T>(vaultIds, fn, options: QueryAcrossOptions = {})` calls `this.openVault(vaultId)` internally.
- `Reducer<R, S=R>` = `{ init(); step(); remove?(); finalize(); op?; field? }` (`aggregate/reducers.ts`; `op`/`field` added in pre.10).
- `NoAccessError`, `InvalidKeyError` exported from `errors.js`.

---

## Phase 1 — #312 A+B: key-custody-neutral fan-out (on the MVP base)

### Task 1: `SkippedVault.reason: 'no-grant'` + classifier

**Files:**
- Modify: `packages/hub/src/federation/types.ts`
- Create: `packages/hub/src/federation/classify-skip.ts`
- Test: `packages/hub/__tests__/federation-vault-group.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to the existing fan-out describe block:

```ts
import { NoAccessError, InvalidKeyError, KeyringCorruptError } from '../src/errors.js'
import { classifyShardSkip } from '../src/federation/classify-skip.js'

describe('classifyShardSkip', () => {
  it('maps NoAccessError (no grant) to no-grant; corruption/credential errors to error', () => {
    expect(classifyShardSkip(new NoAccessError('x'))).toBe('no-grant')
    // #312 comment §2: InvalidKeyError can mean "wrong KEK OR whole-file corruption"
    // (per loadKeyring) — must NOT be masked as the benign no-grant.
    expect(classifyShardSkip(new InvalidKeyError())).toBe('error')
    expect(classifyShardSkip(new KeyringCorruptError({ failedCollections: ['c'], intactCount: 0 }))).toBe('error')
    expect(classifyShardSkip(new Error('store boom'))).toBe('error')
  })
})
```
(Confirm the `KeyringCorruptError` / `InvalidKeyError` constructor shapes against `errors.ts`; the assertion that matters is `NoAccessError → 'no-grant'`, everything else → `'error'`.)

- [ ] **Step 2: Run it — fails** (`classify-skip.js` missing).
Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts -t classifyShardSkip` → FAIL (cannot resolve module).

- [ ] **Step 3: Add the `'no-grant'` union member** in `federation/types.ts`:

```ts
export interface SkippedVault {
  readonly vaultId: string
  readonly reason: 'schema-drift' | 'error' | 'no-grant'
  readonly error?: Error
}
```

- [ ] **Step 4: Create `packages/hub/src/federation/classify-skip.ts`:**

```ts
import { NoAccessError } from '../errors.js'
import type { SkippedVault } from './types.js'

/**
 * Classify a per-shard fan-out failure. `NoAccessError` (no keyring
 * envelope for the calling identity) is the unambiguous not-granted
 * signal → `'no-grant'` (expected under scoped access, not a fault).
 *
 * Everything else → `'error'`. In particular `InvalidKeyError` /
 * `DecryptionError` / `KeyringCorruptError` are NOT no-grant: per
 * `loadKeyring`, a failed unlock can mean "wrong KEK OR whole-file
 * corruption", so masking it as the benign `'no-grant'` would hide a
 * fault. A keyring that exists but won't unlock (credential mismatch
 * or corruption) is a real error to surface.
 */
export function classifyShardSkip(err: Error): Exclude<SkippedVault['reason'], 'schema-drift'> {
  return err instanceof NoAccessError ? 'no-grant' : 'error'
}
```

- [ ] **Step 5: Run the test — passes.** `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts -t classifyShardSkip` → PASS. Also `pnpm --filter @noy-db/hub exec tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add packages/hub/src/federation/types.ts packages/hub/src/federation/classify-skip.ts packages/hub/__tests__/federation-vault-group.test.ts
git commit -m "feat(federation): add SkippedVault reason 'no-grant' + classifyShardSkip (#312 A)"
```

---

### Task 2: no-create open mode (`openVault({ create:false })` + `queryAcross`)

**Files:**
- Modify: `packages/hub/src/noydb.ts` (openVault opts, getKeyringInternal, queryAcross)
- Modify: `packages/hub/src/types.ts` (`QueryAcrossOptions`)
- Test: `packages/hub/__tests__/no-create-open.test.ts` (new)

- [ ] **Step 1: Write the failing test** (a vault owned by alice; bob opens with `create:false` → throws, and writes no keyring):

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { NoAccessError } from '../src/errors.js'
// reuse the inline memory() adapter pattern from __tests__/cross-vault.test.ts (copy it into this file)

it('openVault({create:false}) throws NoAccessError on a vault the caller lacks a grant to, and writes no keyring', async () => {
  const adapter = memory()
  const alice = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  const av = await alice.openVault('client-1')
  await av.collection<{ n: number }>('c').put('r1', { n: 1 })

  const bob = await createNoydb({ store: adapter, user: 'bob', secret: 'bob-pass' })
  await expect(bob.openVault('client-1', { create: false })).rejects.toBeInstanceOf(NoAccessError)
  // bob must NOT have self-provisioned a keyring into alice's vault
  expect(await adapter.get('client-1', '_keyring', 'bob')).toBeNull()
})

it('openVault default (create:true) still bootstraps a new vault', async () => {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'alice', secret: 'alice-pass' })
  const v = await db.openVault('fresh')          // no throw — creates owner keyring
  await v.collection<{ n: number }>('c').put('r1', { n: 1 })
  expect(await adapter.get('fresh', '_keyring', 'alice')).not.toBeNull()
})
```

- [ ] **Step 2: Run it — fails** (currently bob self-provisions, no throw).
Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/no-create-open.test.ts` → FAIL (resolves, returns a vault; keyring written).

- [ ] **Step 3: Thread the `create` option.** In `packages/hub/src/noydb.ts`:

`openVault` signature → add `create`:
```ts
  async openVault(
    name: string,
    opts?: { locale?: string; create?: boolean },
  ): Promise<Vault> {
```
Pass it into the keyring load — change the internal call site `const keyring = await this.getKeyringInternal(name)` (in openVault, ~line 421) to:
```ts
    const keyring = await this.getKeyringInternal(name, { create: opts?.create !== false })
```
Update `getKeyringInternal` signature + the `NoAccessError` branch (~line 2704 / 2747):
```ts
  private async getKeyringInternal(
    vault: string,
    opts: { create: boolean } = { create: true },
  ): Promise<UnlockedKeyring> {
```
```ts
      if (err instanceof NoAccessError) {
        if (!opts.create) throw err   // no-create mode: never self-provision into a vault we lack access to
        // No keyring on disk — first boot or cleared store.
        keyring = await createOwnerKeyring(/* …unchanged… */)
```
(Leave the `InvalidKeyError && onInvalidKey === 'reset'` branch as-is — `create:false` callers don't set `onInvalidKey:'reset'`; an `InvalidKeyError` there surfaces as the no-grant signal.)

Add `create` to `QueryAcrossOptions` in `packages/hub/src/types.ts`:
```ts
export interface QueryAcrossOptions {
  readonly concurrency?: number
  /** Open shards non-creatingly — a missing grant throws instead of self-provisioning. Default false (creating). */
  readonly create?: boolean
}
```
In `queryAcross`, change the internal open `const comp = await this.openVault(vaultId)` to:
```ts
        const comp = await this.openVault(vaultId, { create: options.create !== false ? true : false })
```
(Equivalently `{ create: options.create !== false }`.)

- [ ] **Step 4: Run the test — passes.** Both cases green. Then `pnpm --filter @noy-db/hub test` to confirm no regression (default create path unchanged) + `tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/noydb.ts packages/hub/src/types.ts packages/hub/__tests__/no-create-open.test.ts
git commit -m "feat(hub): openVault/queryAcross no-create mode — never self-provision a non-granted vault (#312 A/B)"
```

---

### Task 3: non-creating open on BOTH paths (fan-out + drill-down) + classify; no-grant tests

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts` (`toArray` fan-out, `openShard`)
- Test: `packages/hub/__tests__/federation-vault-group.test.ts` (append)

This covers **#312 comment §1**: the no-create primitive must apply to the *single-shard* path too. A scoped non-owner doing `shard(key)` (drill-down) or routing a `put` to an existing shard it lacks a grant to must fail cleanly, not self-provision. `openShard` means "open an **existing** shard" → it opens non-creatingly; `shard()` and `put`-routing both go through it. `createShard` stays the sole creating path.

- [ ] **Step 1: Write the failing test** — a granted shard + a non-granted shard in one group:

```ts
it('a shard the fan-out identity cannot open is skipped as no-grant (not error), and no keyring is self-provisioned', async () => {
  // Build a registry + two shards under one operator, then GRANT only one to a second identity.
  // Operator creates both shards (owns them); a separate "advisor" db has a grant to only shard A.
  const adapter = memory()
  const op = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  op.withVaultTemplate('t', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
  const opState = await op.openVault('state')
  const opFirm = await op.openVaultGroup<Invoice>('firm', {
    registry: opState.collection<VaultRegistryRow>('vault-registry'),
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't' },
  })
  await opFirm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
  await opFirm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' })
  // grant advisor only to firm--acme
  await op.grant('firm--acme', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })

  // advisor opens the SAME group (same registry vault — must be granted on 'state' too)
  await op.grant('state', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })
  const adv = await createNoydb({ store: adapter, user: 'advisor', secret: 'adv-pass' })
  adv.withVaultTemplate('t', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
  const advState = await adv.openVault('state')
  const advFirm = await adv.openVaultGroup<Invoice>('firm', {
    registry: advState.collection<VaultRegistryRow>('vault-registry'),
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't' },
  })

  const out = await advFirm.collection('invoices').query().where('status', '==', 'overdue').toArray()
  expect(out.results.map((r) => r.amount)).toEqual([100])               // only acme (granted)
  const skip = out.skippedVaults.find((s) => s.vaultId === 'firm--beta')
  expect(skip?.reason).toBe('no-grant')
  expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull() // no self-provision

  // §1: the SAME hazard on the single-shard drill-down — advisor drills into a
  // shard it lacks a grant to → clean failure, NOT a self-provisioned keyring.
  await expect(advFirm.shard('beta')).rejects.toBeInstanceOf(NoAccessError)
  expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull()
  // and a routed write to that non-granted shard also fails cleanly (existing row → openShard)
  await expect(
    advFirm.collection('invoices').put('x', { clientId: 'beta', amount: 9, status: 'open' }),
  ).rejects.toBeInstanceOf(NoAccessError)
  expect(await adapter.get('firm--beta', '_keyring', 'advisor')).toBeNull()
})
```
(`NoAccessError` imported at top. Confirm the grant API shape against `cross-vault.test.ts`; adjust `role`/fields if needed. The behavioral contract — no-grant skip on fan-out + clean throw on drill-down/write + zero self-provision — is fixed.)

- [ ] **Step 2: Run it — fails** (today the open self-provisions → advisor sees beta as empty/error, or reads it).

- [ ] **Step 3a: Wire the fan-out** in `toArray` (`vault-group.ts`) — open non-creatingly and classify:

Change the `queryAcross` call's options to `{ concurrency: options.concurrency ?? 1, create: false }`, and change the skip-folding tail from:
```ts
      if (r.error) skipped.push({ vaultId: r.vault, reason: 'error', error: r.error })
```
to:
```ts
      if (r.error) skipped.push({ vaultId: r.vault, reason: classifyShardSkip(r.error), error: r.error })
```
Add `import { classifyShardSkip } from './classify-skip.js'` at the top of `vault-group.ts`.

- [ ] **Step 3b: Make `openShard` non-creating** (closes the §1 drill-down hazard). Change `openShard` so it opens existing shards only:
```ts
  async openShard(partitionKey: string): Promise<Vault> {
    const vault = await this.db.openVault(this.shardVaultId(partitionKey), { create: false })
    this.template.configure(vault)
    return vault
  }
```
Verify `createShard`'s **create** branch still uses `this.db.openVault(vaultId)` *without* `{ create: false }` (it legitimately provisions). Its idempotent `row && provisioned` branch calls `openShard` — fine: a granted owner still opens; a non-grant correctly throws `NoAccessError`. `shard()` and `ShardedCollection.put`'s existing-row branch already route through `openShard`, so they inherit clean-fail automatically.

- [ ] **Step 4: Run tests — pass.** The two new tests + the existing 16 federation tests (`pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts`) + `tsc --noEmit`. (The existing error-branch test injects a store `list` failure → still `'error'`; the MVP createShard/reconcile tests still pass because the single operator owns its shards.)

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-vault-group.test.ts
git commit -m "feat(federation): fan-out opens non-creatingly + classifies no-grant vs error (#312 A/B)"
```

---

### Task 4: state the key-custody-neutral contract (B, docs)

**Files:**
- Modify: `docs/subsystems/vault-group.md`

- [ ] **Step 1: Add a "Key-custody model" section** to `docs/subsystems/vault-group.md`:

```markdown
## Key-custody model

VaultGroup operations run **as the calling `Noydb` identity** holding *some* grants — not
necessarily every shard. The fan-out (`query().toArray()` and the live/aggregate surface)
returns the **openable subset** for that identity: a shard the caller lacks a grant to is
reported in `skippedVaults` with `reason: 'no-grant'` — expected under scoped access, **not a
fault**. The all-owning operator (one identity that created and can open every shard) is one
configuration, not the contract.

Do **not** assume "fan-out results = all shards." Distinguish the three skip reasons:
`'schema-drift'` (below `minVersion`), `'no-grant'` (caller has no keyring for the shard;
classified from `NoAccessError` only — `InvalidKeyError`/corruption stay `'error'`), and
`'error'` (genuine fault, incl. `ShardProvisioningError` = registry row present but vault gone).
All federation open paths are **non-creating** (`shard()`/`put`-routing via `openShard`, and the
fan-out), so a missing grant fails cleanly rather than self-provisioning a keyring into the vault.
`createShard` is the only creating path.

### Registry visibility (roster is not scoped)

Opening a VaultGroup requires a grant to the **registry vault**; shard grants then determine the
openable subset. But the `vault-registry` is one shared collection of **plaintext** rows — any
member who can read it sees **every** `partitionKey`/`vaultId`, including shards it cannot open.
Roster *existence* is not scoped (only shard *data* is). Therefore:

- **`keyOf` must return an opaque partition key.** Do **not** key by a sensitive human
  identifier (tax id, name) — these become plaintext-visible to every group member. Use an
  opaque internal id (e.g. a ULID `clientId`) and keep sensitive identifiers *inside* the
  shard's records.
- **Per-identity roster scoping** (an identity seeing only its assigned rows) is **not**
  provided by a single shared registry — it needs row-level access or per-identity views, out of
  scope today.
```

- [ ] **Step 2: Validate docs registry.** Run `node scripts/validate-features.mjs` → OK (path already registered).

- [ ] **Step 3: Commit.**
```bash
git add docs/subsystems/vault-group.md
git commit -m "docs(federation): state key-custody-neutral fan-out contract (#312 B)"
```

> After Phase 1: **rebase `feat/m16-cross-vault-live-aggregate` onto the updated MVP branch** before Phase 2/3 (`git checkout feat/m16-cross-vault-live-aggregate && git rebase feat/m16-mvf-vaultgroup-routing`).

---

## Phase 2 — #312 E: `Reducer.merge` (on the cross-vault-live branch)

### Task 5: optional `Reducer.merge` + 5 built-ins + unit tests

**Files:**
- Modify: `packages/hub/src/aggregate/reducers.ts`
- Test: `packages/hub/__tests__/reducer-merge.test.ts` (new)

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest'
import { sum, count, avg, min, max } from '../src/aggregate/reducers.js'

// merge-then-finalize must equal reduce-over-concatenation (state-level invariant)
function reduceState(r: ReturnType<typeof sum>, records: unknown[]) {
  let s = r.init(); for (const rec of records) s = r.step(s, rec); return s
}

describe('Reducer.merge', () => {
  const A = [{ v: 10 }, { v: 20 }]
  const B = [{ v: 30 }]
  for (const [name, make] of [['sum', () => sum('v')], ['count', () => count()], ['avg', () => avg('v')], ['min', () => min('v')], ['max', () => max('v')]] as const) {
    it(`${name}: merge(stateA,stateB) finalizes to reduce(A∪B)`, () => {
      const r = make() as any
      expect(typeof r.merge).toBe('function')
      const sA = reduceState(r, A), sB = reduceState(r, B)
      const merged = r.finalize(r.merge(sA, sB))
      const whole = r.finalize(reduceState(r, [...A, ...B]))
      expect(merged).toEqual(whole)
      // commutativity + identity
      expect(r.finalize(r.merge(sB, sA))).toEqual(whole)
      expect(r.finalize(r.merge(r.init(), sA))).toEqual(r.finalize(sA))
    })
  }
})
```

- [ ] **Step 2: Run it — fails** (`r.merge` undefined).

- [ ] **Step 3: Add `merge?` to the interface** (`reducers.ts`, after `finalize`):
```ts
  /**
   * Combine two independent partial states into one (then `finalize`
   * once). Optional. Enables parallel/hierarchical aggregation
   * (e.g. cross-shard or advisor→firm rollup). MUST be associative +
   * commutative with `init()` as identity. Never merge finalized
   * results — only states.
   */
  merge?(a: S, b: S): S
```

- [ ] **Step 4: Implement on the 5 built-ins.** Add a `merge` to each factory's returned object:
- `count`: state is `number` → `merge: (a, b) => a + b`
- `sum`: state is `number` → `merge: (a, b) => a + b`
- `min`: state `{ value }` or number — match the actual state shape in the file; `merge` takes the lesser non-null. (Read the file: `min`/`max` state is likely `number | null`.) For `number|null`: `merge: (a, b) => a === null ? b : b === null ? a : Math.min(a, b)` (max → `Math.max`).
- `avg`: state `{ sum, count }` → `merge: (a, b) => ({ sum: a.sum + b.sum, count: a.count + b.count })`.
Match each factory's exact state type (read the impls; `avg` uses `{ sum, count }`).

- [ ] **Step 5: Run the test — passes.** Then `pnpm --filter @noy-db/hub test` (additive — existing aggregate/MV tests stay green) + `tsc --noEmit` (+ typetest).

- [ ] **Step 6: Commit.**
```bash
git add packages/hub/src/aggregate/reducers.ts packages/hub/__tests__/reducer-merge.test.ts
git commit -m "feat(hub): optional Reducer.merge for parallel/hierarchical combine — closes #312 E"
```

---

## Phase 3 — cross-vault live + aggregate slice (on the cross-vault-live branch)

### Task 6: federation types for the live/aggregate surface

**Files:**
- Modify: `packages/hub/src/federation/types.ts`

- [ ] **Step 1: Add the option + row + live interfaces** to `federation/types.ts`:

```ts
import type { LiveQuery } from '../query/live.js'
import type { LiveAggregation } from '../aggregate/aggregation.js'
import type { AggregateResult, AggregateSpec } from '../aggregate/aggregation.js'

/** Options for the live/aggregate fan-out (extends the one-shot opts). */
export interface LiveQueryOptions extends FanoutQueryOptions {
  /** Coalesce window before recompute. Default 0 (microtask). */
  readonly debounceMs?: number
}

/** A grouped aggregate output row: the grouped field + the reduced spec result. */
export type GroupedRow<F extends string, Spec extends AggregateSpec> =
  { readonly [K in F]: unknown } & AggregateResult<Spec>

/** Reactive cross-shard record (or grouped-row) query — array-shaped, mirrors LiveQuery<T>. */
export interface CrossVaultLiveQuery<T> extends LiveQuery<T> {
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}

/** Reactive cross-shard scalar aggregate — mirrors LiveAggregation<R>. */
export interface CrossVaultLiveAggregation<R> extends LiveAggregation<R> {
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}
```
(Verify the exact export names/paths of `AggregateResult`/`AggregateSpec`/`LiveAggregation` in `aggregate/aggregation.js` and `LiveQuery` in `query/live.js`; adjust imports.)

- [ ] **Step 2: Typecheck.** `pnpm --filter @noy-db/hub exec tsc --noEmit` → clean.

- [ ] **Step 3: Commit.**
```bash
git add packages/hub/src/federation/types.ts
git commit -m "feat(federation): live/aggregate option + row + facade types"
```

---

### Task 7: `CrossVaultLive<S>` reactive core

**Files:**
- Create: `packages/hub/src/federation/cross-vault-live.ts`
- Test: `packages/hub/__tests__/cross-vault-live-core.test.ts` (new)

- [ ] **Step 1: Write the failing test** (drive the core with a fake emitter + async compute):

```ts
import { describe, it, expect } from 'vitest'
import { CrossVaultLive } from '../src/federation/cross-vault-live.js'

function fakeEmitter() {
  const hs = new Set<(e: any) => void>()
  return {
    subscribe: (h: (e: any) => void) => { hs.add(h); return () => hs.delete(h) },
    fire: (e: any) => { for (const h of hs) h(e) },
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

it('computes initial snapshot, updates on relevant change, single-flights, stops', async () => {
  const em = fakeEmitter()
  let n = 0
  const core = new CrossVaultLive<number>({
    subscribeToChanges: em.subscribe,
    isRelevant: (e) => e.relevant === true,
    compute: async () => { await tick(); return ++n },
    initialSnapshot: 0,
    debounceMs: 0,
  })
  expect(core.snapshot).toBe(0)              // initial, before first settle
  await core.ready                            // first compute settled
  expect(core.snapshot).toBe(1)

  let fired = 0
  const off = core.subscribe(() => { fired++ })
  em.fire({ relevant: false })                // ignored
  await tick(); await tick()
  expect(core.snapshot).toBe(1)
  em.fire({ relevant: true })
  await new Promise((r) => setTimeout(r, 5))
  expect(core.snapshot).toBe(2)
  expect(fired).toBeGreaterThanOrEqual(1)

  off(); core.stop()
  em.fire({ relevant: true })
  await new Promise((r) => setTimeout(r, 5))
  expect(core.snapshot).toBe(2)              // stopped → no recompute
})
```

- [ ] **Step 2: Run it — fails** (module missing).

- [ ] **Step 3: Implement `cross-vault-live.ts`:**

```ts
/**
 * @category capability
 * Reactive core for cross-vault live queries/aggregations. Generic over a
 * snapshot S. Single-flight + microtask-coalesced recompute on relevant
 * change. Mirrors the LiveQuery/LiveAggregation contracts via facades.
 * Spec: docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md.
 */
import type { ChangeEvent } from '../types.js'

export interface CrossVaultLiveOptions<S> {
  readonly subscribeToChanges: (handler: (e: ChangeEvent) => void) => () => void
  readonly isRelevant: (e: ChangeEvent) => boolean
  readonly compute: () => Promise<S>
  readonly initialSnapshot: S
  readonly debounceMs?: number
}

export class CrossVaultLive<S> {
  snapshot: S
  error: Error | null = null
  readonly ready: Promise<void>

  private readonly subs = new Set<() => void>()
  private readonly unsubChange: () => void
  private readonly opts: CrossVaultLiveOptions<S>
  private stopped = false
  private computing = false
  private dirty = false
  private scheduled = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolveReady!: () => void
  private settledOnce = false

  constructor(opts: CrossVaultLiveOptions<S>) {
    this.opts = opts
    this.snapshot = opts.initialSnapshot
    this.ready = new Promise<void>((res) => { this.resolveReady = res })
    this.unsubChange = opts.subscribeToChanges((e) => {
      if (this.stopped || !opts.isRelevant(e)) return
      this.schedule()
    })
    this.schedule() // initial compute
  }

  subscribe(cb: () => void): () => void {
    if (this.stopped) return () => {}
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unsubChange()
    if (this.timer !== null) clearTimeout(this.timer)
    this.subs.clear()
    if (!this.settledOnce) this.resolveReady() // never leave ready dangling
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.computing) { this.dirty = true; return }
    if (this.scheduled) return
    this.scheduled = true
    const run = () => { this.scheduled = false; void this.runCompute() }
    const ms = this.opts.debounceMs ?? 0
    if (ms > 0) this.timer = setTimeout(run, ms)
    else queueMicrotask(run)
  }

  private async runCompute(): Promise<void> {
    if (this.stopped) return
    this.computing = true
    this.dirty = false
    try {
      const next = await this.opts.compute()
      if (this.stopped) return
      this.snapshot = next
      this.error = null
    } catch (err) {
      if (this.stopped) return
      this.error = err instanceof Error ? err : new Error(String(err))
    } finally {
      this.computing = false
      if (!this.stopped) {
        if (!this.settledOnce) { this.settledOnce = true; this.resolveReady() }
        for (const cb of this.subs) cb()
        if (this.dirty) this.schedule()
      }
    }
  }
}
```

- [ ] **Step 4: Run the test — passes.** + `tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/federation/cross-vault-live.ts packages/hub/__tests__/cross-vault-live-core.test.ts
git commit -m "feat(federation): CrossVaultLive reactive core (single-flight + debounce + ready)"
```

---

### Task 8: extract `resolveEligible` / `fanoutRecords` (DRY refactor)

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-vault-group.test.ts` (existing — regression only)

- [ ] **Step 1: Add `VaultGroup.resolveEligible`** (lift the minVersion + provisioning logic out of `toArray`):

```ts
  /** @internal — eligible (openable-candidate) rows + drift/divergence skips. */
  async resolveEligible(options: { minVersion?: number } = {}): Promise<{
    eligible: VaultRegistryRow[]
    skipped: SkippedVault[]
  }> {
    const rows = await this.allRows()
    const skipped: SkippedVault[] = []
    const versionOk: VaultRegistryRow[] = []
    for (const row of rows) {
      if (options.minVersion !== undefined && row.schemaVersion < options.minVersion) {
        skipped.push({ vaultId: row.vaultId, reason: 'schema-drift' })
      } else versionOk.push(row)
    }
    const provisioned = await Promise.all(versionOk.map((r) => this.db._shardVaultProvisioned(r.vaultId)))
    const eligible: VaultRegistryRow[] = []
    versionOk.forEach((row, i) => {
      if (provisioned[i]) eligible.push(row)
      else skipped.push({ vaultId: row.vaultId, reason: 'error', error: new ShardProvisioningError(row.vaultId, row.partitionKey) })
    })
    return { eligible, skipped }
  }
```

- [ ] **Step 2: Add `ShardedQuery.fanoutRecords`** (the shared record fan-out):

```ts
  /** @internal — fan out the where-filtered records across eligible shards. */
  async fanoutRecords(options: FanoutQueryOptions = {}): Promise<{ records: R[]; skippedVaults: SkippedVault[] }> {
    const { eligible, skipped } = await this.group.resolveEligible(options)
    const across = await this.group.db.queryAcross<R[]>(
      eligible.map((r) => r.vaultId),
      async (vault) => {
        this.group.template.configure(vault)
        const coll = vault.collection<R>(this.collectionName)
        await coll.list()
        let q = coll.query()
        for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
        return q.toArray()
      },
      { concurrency: options.concurrency ?? 1, create: false },
    )
    const results: R[] = []
    for (const r of across) {
      if (r.error) skipped.push({ vaultId: r.vault, reason: classifyShardSkip(r.error), error: r.error })
      else for (const item of r.result) results.push(item)
    }
    return { records: results, skippedVaults: skipped }
  }
```

- [ ] **Step 3: Reduce `toArray` to one line:**
```ts
  async toArray(options: FanoutQueryOptions = {}): Promise<FanoutResult<R>> {
    const { records, skippedVaults } = await this.fanoutRecords(options)
    return { results: records, skippedVaults }
  }
```

- [ ] **Step 4: Run the full federation file — all 16 MVP tests + Task-3 no-grant test still pass** (behavior identical). `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts` + `tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/federation/vault-group.ts
git commit -m "refactor(federation): extract resolveEligible/fanoutRecords (shared by toArray/live/aggregate)"
```

---

### Task 9: `ShardedQuery.live()` + `CrossVaultLiveQuery` facade

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-query-aggregate.test.ts` (new)

- [ ] **Step 1: Write the failing test** (reuse the harness from `federation-vault-group.test.ts` — copy `memory()`/`Invoice`/`harness` into this file; add `waitFor`):

```ts
async function waitFor(pred: () => boolean, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now()
  while (!pred()) { if (Date.now() - start > timeout) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, interval)) }
}

it('live() reflects initial + reacts to writes + picks up a new shard, then stop()', async () => {
  const h = await harness()
  await h.firm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
  const lq = h.firm.collection('invoices').query().where('status', '==', 'overdue').live()
  await lq.ready
  expect(lq.value.map((r) => r.amount)).toEqual([100])
  expect(lq.skippedVaults).toEqual([])

  await h.firm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' }) // new shard
  await waitFor(() => lq.value.length === 2)
  expect(lq.value.map((r) => r.amount).sort((x, y) => x - y)).toEqual([100, 200])

  lq.stop()
  await h.firm.collection('invoices').put('a2', { clientId: 'acme', amount: 300, status: 'overdue' })
  await new Promise((r) => setTimeout(r, 30))
  expect(lq.value.length).toBe(2) // stopped
})
```

- [ ] **Step 2: Run it — fails** (`.live` missing).

- [ ] **Step 3: Implement `ShardedQuery.live`** in `vault-group.ts` (+ the facade). Add imports for `CrossVaultLive` and the facade types, then:

```ts
  live(options: LiveQueryOptions = {}): CrossVaultLiveQuery<R> {
    const group = this.group
    const collectionName = this.collectionName
    const core = new CrossVaultLive<{ records: R[]; skipped: SkippedVault[] }>({
      subscribeToChanges: (h) => { group.db.on('change', h); return () => group.db.off('change', h) },
      isRelevant: (e) => e.collection === collectionName && e.vault.startsWith(`${group.name}--`),
      compute: async () => {
        const { records, skippedVaults } = await this.fanoutRecords(options)
        return { records, skipped: skippedVaults }
      },
      initialSnapshot: { records: [], skipped: [] },
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    })
    return {
      get value() { return core.snapshot.records as readonly R[] },
      get skippedVaults() { return core.snapshot.skipped as readonly SkippedVault[] },
      get error() { return core.error },
      ready: core.ready,
      subscribe: (cb) => core.subscribe(cb),
      stop: () => core.stop(),
    }
  }
```
(`LiveQueryOptions`, `CrossVaultLiveQuery`, `SkippedVault` imported from `./types.js`; `CrossVaultLive` from `./cross-vault-live.js`.)

- [ ] **Step 4: Run the test — passes.** + `tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-query-aggregate.test.ts
git commit -m "feat(federation): ShardedQuery.live() — reactive cross-shard records (queryAcrossLive)"
```

---

### Task 10: `aggregate(spec)` / `groupBy().aggregate(spec)` one-shot

**Files:**
- Create: `packages/hub/src/federation/aggregate-across.ts`
- Modify: `packages/hub/src/federation/vault-group.ts` (`aggregate`, `groupBy`, `ShardedGroupedQuery`)
- Test: `packages/hub/__tests__/federation-query-aggregate.test.ts` (append)

- [ ] **Step 1: Write the failing test** (avg correctness across shards is the key assertion):

```ts
import { sum, count, avg } from '../src/aggregate/reducers.js'

it('aggregate across shards: sum/count/avg correct (avg = central reduce, not avg-of-avgs)', async () => {
  const h = await harness()
  const inv = h.firm.collection('invoices')
  await inv.put('a1', { clientId: 'acme', amount: 100, status: 'open' })
  await inv.put('a2', { clientId: 'acme', amount: 200, status: 'open' })
  await inv.put('b1', { clientId: 'beta', amount: 300, status: 'open' })
  const { result, skippedVaults } = await h.firm.collection('invoices').query()
    .aggregate({ total: sum('amount'), n: count(), mean: avg('amount') }).run()
  expect(skippedVaults).toEqual([])
  expect(result.total).toBe(600)
  expect(result.n).toBe(3)
  expect(result.mean).toBe(200) // NOT (150+300)/2 = 225
})

it('groupBy(status).aggregate sums per status across shards', async () => {
  const h = await harness()
  const inv = h.firm.collection('invoices')
  await inv.put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
  await inv.put('b1', { clientId: 'beta', amount: 300, status: 'overdue' })
  await inv.put('b2', { clientId: 'beta', amount: 50, status: 'open' })
  const { results } = await h.firm.collection('invoices').query()
    .groupBy('status').aggregate({ total: sum('amount') }).run()
  const overdue = results.find((r) => r.status === 'overdue')
  expect(overdue?.total).toBe(400)
})
```

- [ ] **Step 2: Run it — fails** (`.aggregate`/`.groupBy` missing).

- [ ] **Step 3: Create `federation/aggregate-across.ts`:**

```ts
import { reduceRecords } from '../aggregate/aggregation.js'
import { groupAndReduce } from '../aggregate/groupby.js'
import type { AggregateResult, AggregateSpec } from '../aggregate/aggregation.js'
import type { FanoutQueryOptions, SkippedVault, GroupedRow, CrossVaultLiveAggregation, CrossVaultLiveQuery } from './types.js'

export interface FanoutRecordSource<R> {
  fanoutRecords(options: FanoutQueryOptions): Promise<{ records: R[]; skippedVaults: SkippedVault[] }>
}

export class CrossVaultAggregation<R, Spec extends AggregateSpec> {
  constructor(private readonly src: FanoutRecordSource<R>, private readonly spec: Spec) {}
  async run(options: FanoutQueryOptions = {}): Promise<{ result: AggregateResult<Spec>; skippedVaults: SkippedVault[] }> {
    const { records, skippedVaults } = await this.src.fanoutRecords(options)
    return { result: reduceRecords(records, this.spec), skippedVaults }
  }
  // live(): CrossVaultLiveAggregation<...> — added in Task 11
}

export class CrossVaultGroupedAggregation<R, F extends string, Spec extends AggregateSpec> {
  constructor(private readonly src: FanoutRecordSource<R>, private readonly field: F, private readonly spec: Spec) {}
  async run(options: FanoutQueryOptions = {}): Promise<{ results: GroupedRow<F, Spec>[]; skippedVaults: SkippedVault[] }> {
    const { records, skippedVaults } = await this.src.fanoutRecords(options)
    return { results: groupAndReduce<GroupedRow<F, Spec>>(records, this.field, this.spec), skippedVaults }
  }
  // live(): CrossVaultLiveQuery<...> — added in Task 11
}
```
(Verify `reduceRecords`/`groupAndReduce` import paths; both confirmed in `aggregate/`.)

- [ ] **Step 4: Add `aggregate`/`groupBy` to `ShardedQuery` + `ShardedGroupedQuery`** in `vault-group.ts`:

```ts
  aggregate<Spec extends AggregateSpec>(spec: Spec): CrossVaultAggregation<R, Spec> {
    return new CrossVaultAggregation<R, Spec>(this, spec)
  }
  groupBy<F extends string>(field: F): ShardedGroupedQuery<T, R, F> {
    return new ShardedGroupedQuery<T, R, F>(this, field)
  }
```
```ts
export class ShardedGroupedQuery<T, R, F extends string> {
  constructor(private readonly query: ShardedQuery<T, R>, private readonly field: F) {}
  aggregate<Spec extends AggregateSpec>(spec: Spec): CrossVaultGroupedAggregation<R, F, Spec> {
    return new CrossVaultGroupedAggregation<R, F, Spec>(
      { fanoutRecords: (o) => this.query.fanoutRecords(o) }, this.field, spec,
    )
  }
}
```
(`ShardedQuery` already satisfies `FanoutRecordSource<R>` via `fanoutRecords`; pass `this`.)

- [ ] **Step 5: Run the tests — pass.** + `tsc --noEmit`.

- [ ] **Step 6: Commit.**
```bash
git add packages/hub/src/federation/aggregate-across.ts packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-query-aggregate.test.ts
git commit -m "feat(federation): aggregateAcross — one-shot distributed reduce + groupBy (central reduce)"
```

---

### Task 11: `aggregate().live()` (reactive distributed reduce)

**Files:**
- Modify: `packages/hub/src/federation/aggregate-across.ts`
- Test: `packages/hub/__tests__/federation-query-aggregate.test.ts` (append)

- [ ] **Step 1: Write the failing test:**

```ts
it('aggregate().live() updates the scalar on write', async () => {
  const h = await harness()
  await h.firm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'open' })
  const la = h.firm.collection('invoices').query().aggregate({ total: sum('amount') }).live()
  await la.ready
  expect(la.value?.total).toBe(100)
  await h.firm.collection('invoices').put('b1', { clientId: 'beta', amount: 50, status: 'open' })
  await waitFor(() => la.value?.total === 150)
  la.stop()
})
```

- [ ] **Step 2: Run it — fails** (`.live` missing on the aggregation wrapper).

- [ ] **Step 3: Add `live()` to both wrappers** in `aggregate-across.ts`. They need the group's emitter + relevance; thread a small `LiveBinding` from `ShardedQuery` (the group name + collection + `db`). Extend the wrappers' constructors to also accept a `bind: { subscribeToChanges, isRelevant }` (built by `ShardedQuery` the same way `live()` does), then:

```ts
  // on CrossVaultAggregation:
  live(options: LiveQueryOptions = {}): CrossVaultLiveAggregation<AggregateResult<Spec>> {
    const core = new CrossVaultLive<{ value: AggregateResult<Spec> | undefined; skipped: SkippedVault[] }>({
      ...this.bind,
      compute: async () => {
        const { records, skippedVaults } = await this.src.fanoutRecords(options)
        return { value: reduceRecords(records, this.spec), skipped: skippedVaults }
      },
      initialSnapshot: { value: undefined, skipped: [] },
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    })
    return {
      get value() { return core.snapshot.value },
      get skippedVaults() { return core.snapshot.skipped },
      get error() { return core.error },
      ready: core.ready,
      subscribe: (cb) => core.subscribe(cb),
      stop: () => core.stop(),
    }
  }
```
`CrossVaultGroupedAggregation.live()` is the same but snapshot `{ rows: GroupedRow[]; skipped }`, returns a `CrossVaultLiveQuery<GroupedRow<F,Spec>>` (value = rows, array-shaped), using `groupAndReduce`. Update `ShardedQuery.aggregate`/`ShardedGroupedQuery.aggregate` to pass the `bind` (factor the `subscribeToChanges`/`isRelevant` construction from Task 9 into a small `ShardedQuery.liveBinding()` helper and reuse it).

- [ ] **Step 4: Run the test — passes.** + `tsc --noEmit`.

- [ ] **Step 5: Commit.**
```bash
git add packages/hub/src/federation/aggregate-across.ts packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-query-aggregate.test.ts
git commit -m "feat(federation): aggregateAcrossLive — reactive distributed reduce (ungrouped + grouped)"
```

---

### Task 12: public exports + adapter shape-compat type test

**Files:**
- Modify: `packages/hub/src/federation/index.ts`, `packages/hub/src/index.ts`
- Test: `packages/hub/__tests__/cross-vault-live.test-d.ts` (new)

- [ ] **Step 1: Write the type-compat test** (`*.test-d.ts`, checked by `tsconfig.typetest.json`):

```ts
import { expectTypeOf } from 'vitest'
import type { CrossVaultLiveQuery, CrossVaultLiveAggregation } from '../src/federation/index.js'
import type { LiveQuery } from '../src/query/live.js'
import type { LiveAggregation } from '../src/aggregate/aggregation.js'

expectTypeOf<CrossVaultLiveQuery<{ a: number }>>().toMatchTypeOf<LiveQuery<{ a: number }>>()
expectTypeOf<CrossVaultLiveAggregation<{ total: number }>>().toMatchTypeOf<LiveAggregation<{ total: number }>>()
```

- [ ] **Step 2: Add exports.** In the internal barrel `federation/index.ts`, value-export the new
classes (internal consumers may need them):
```ts
export { CrossVaultAggregation, CrossVaultGroupedAggregation } from './aggregate-across.js'
export { ShardedGroupedQuery } from './vault-group.js'
export type { CrossVaultLiveQuery, CrossVaultLiveAggregation, LiveQueryOptions, GroupedRow } from './types.js'
```
(`CrossVaultLive` is the internal reactive core — do **not** export it from the public entry.)

From the **public entry** `packages/hub/src/index.ts`, re-export these **type-only** — matching the
MVP convention (`export type { VaultGroup, ShardedCollection, ShardedQuery }`). These classes are
**never constructed by consumers** — `CrossVaultAggregation`/`CrossVaultGroupedAggregation` are
returned by `.aggregate()`, `ShardedGroupedQuery` by `.groupBy()`, the live facades by `.live()`.
Type-only keeps the only runtime edge to federation the dynamic `import()` in `openVaultGroup`, so
the chunk stays excluded for ESM/CJS/non-tree-shaking consumers alike:
```ts
export type {
  CrossVaultAggregation, CrossVaultGroupedAggregation, ShardedGroupedQuery,
  CrossVaultLiveQuery, CrossVaultLiveAggregation, LiveQueryOptions, GroupedRow,
} from './federation/index.js'
```
(If any of these is genuinely needed as a runtime value by a consumer — none is today — promote it
to a value export *and* re-verify the bundle-floor leak canaries stay clean.)

- [ ] **Step 3: Run typecheck + typetest.** `pnpm --filter @noy-db/hub run typecheck` → clean (both configs).

- [ ] **Step 4: Commit.**
```bash
git add packages/hub/src/federation/index.ts packages/hub/src/index.ts packages/hub/__tests__/cross-vault-live.test-d.ts
git commit -m "feat(federation): export live/aggregate surface + LiveQuery shape-compat type test"
```

---

### Task 13: showcase 99 + features.yaml

**Files:**
- Create: `showcases/src/99-vault-group-live-aggregate.showcase.test.ts`
- Modify: `features.yaml`

- [ ] **Step 1: Write the showcase** (mirror showcase 98's structure; import from `@noy-db/hub` + `@noy-db/to-memory`). Demonstrate: `.query().where().live()` (assert via `await lq.ready` + a `waitFor` after a write), `.aggregate({...}).run()` (sum/avg across shards), `.groupBy('clientId').aggregate({...}).run()`. Generic firm/clients framing, no client names.

- [ ] **Step 2: Rebuild hub + run the showcase.**
```bash
pnpm --filter @noy-db/hub build
pnpm --filter @noy-db/showcases exec vitest run src/99-vault-group-live-aggregate.showcase.test.ts
```
Expected: PASS.

- [ ] **Step 3: Register in `features.yaml`** — add to the `vault-group-federation` entry's `showcases:` list:
```yaml
      - id: 99-vault-group-live-aggregate
        path: showcases/src/99-vault-group-live-aggregate.showcase.test.ts
```

- [ ] **Step 4: Validate.** `node scripts/validate-features.mjs` → OK.

- [ ] **Step 5: Commit.**
```bash
git add showcases/src/99-vault-group-live-aggregate.showcase.test.ts features.yaml
git commit -m "docs(federation): showcase 99 — live + distributed aggregate; register in features.yaml"
```

---

### Task 14: final verification

- [ ] **Step 1: Full gate.**
```bash
pnpm --filter @noy-db/hub run typecheck
pnpm --filter @noy-db/hub test
node scripts/validate-features.mjs
pnpm --filter @noy-db/hub build
pnpm --filter @noy-db/hub bundle-check     # federation stays a lazy chunk; note the pre-existing stale-baseline caveat — judge by leak canaries, not headline gz
node scripts/check-architecture.mjs        # collection.ts unchanged here; openVault edit is small — confirm kernel-surface ceiling not breached
```
Expected: typecheck/test/validate-features/architecture pass; bundle-check leak canaries clean (federation not in core entry).

- [ ] **Step 2: Confirm `join.ts` untouched.** `git diff --stat main -- packages/hub/src/query/join.ts` → empty.

---

## Self-review notes (for the implementer)

- **Spec coverage:** A → Tasks 1–4; B → Tasks 2–4 (no-create open + contract doc); E → Task 5; reactive core → Task 7; `live()` → Task 9; `aggregate`/`groupBy` one-shot → Task 10; `aggregate().live()` → Task 11; `ready`/`stop`/`skippedVaults`/shape-compat → Tasks 7/9/11/12; central-reduce + avg correctness → Task 10; showcase → Task 13.
- **No-grant test realism (Task 3):** uses a real second identity with a grant to only one shard — this exercises the actual `NoAccessError` path, and asserts no rogue keyring is written (the security property). If the grant/role API differs, align with `cross-vault.test.ts`; the behavioral contract (no-grant skip + no self-provision) is fixed.
- **Type consistency:** `fanoutRecords` returns `{ records, skippedVaults }` everywhere; `CrossVaultAggregation.run` returns `{ result, skippedVaults }`; grouped returns `{ results, skippedVaults }`; live facades expose `value`/`skippedVaults`/`error`/`ready`/`subscribe`/`stop`.
- **merge is state-level (Task 5):** the test asserts merge-then-finalize ≡ reduce-over-concatenation — never merge finalized results.
- **Deferred (do NOT build):** distributed partial-reduce using `merge`, hierarchical rollup, multi-key groupBy, framework adapters, the four #312 out-of-scope items.
```
