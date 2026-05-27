# `carryLedger` Opt-In — Implementation Plan (Plan 7, #205, slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **This is the riskiest slice in the epic — a hash-chain reconstruction.** Execute it as its own focused pass, ideally after an advisor review of the approach. The gating correctness test is `verifyBackupIntegrity()` returning `ok: true` over the re-keyed data — a subtle slip produces a chain that fails verification or (worse) passes a weak test while being corrupt. Do NOT rush it.

**Goal:** Add `carryLedger?: boolean` (default `false`) to `extractPartition` (#205). When on, the source `_ledger` audit chain is filtered to the extracted closure, re-keyed under a fresh destination ledger DEK, **re-chained** (fresh indices + `prevHash`), with each entry's `payloadHash` **recomputed against the re-keyed record ciphertext** — so the recipient's `verifyBackupIntegrity()` passes over the carried chain.

**Scope (slice 1):** `_ledger` entries only (`op: put | delete`). `_ledger_deltas` (historical versions) and `_history` snapshots are **deferred to a follow-up** — they add re-keying of delta envelopes + `deltaHash` re-derivation on top of this. Amendment entries (multi-record, empty `collection`/`id`) are dropped in slice 1.

**Architecture:** Concentrated in `extract-partition.ts`. `_ledger` entries are encrypted under `getDEK('_ledger')` (a regular collection DEK), so the design mints a fresh destination `_ledger` DEK, **adds it to the sealed DEK set** (so #208 wraps it into the recipient keyring automatically — no #208 change), and writes the re-chained entries into `backup._internal._ledger` + a recomputed `backup.ledgerHead`. The `adoptPartition` `_internal` import (Plan 6) already lands them. The recipient must open with a history strategy for `verifyBackupIntegrity` to find the chain.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (`history/ledger`, `crypto.ts`, bundle subsystem).

---

## Epic context

**Plan 7 of the Transferable Partition Bundles epic.** Plans 1–6 (ceremony + `carrySchemas`) are in PR #225. `carryLedger` is the last carry opt-in; the recipient-side plumbing (`_internal` import in `adoptPartition`, generic DEK wrapping in #208) is already in place from Plan 6 / Plan 5, so this plan is almost entirely producer-side.

## Confirmed facts (grounded in tree)

- **`_ledger/<paddedIndex>` is an encrypted envelope.** Entry serialization: `_data = encrypt(canonicalJson(entry), getDEK('_ledger'))`; envelope `{ _noydb, _v: index+1, _ts: entry.ts, _iv, _data, _by: entry.actor }` (`store.ts:649-671`). `paddedIndex(n)` = `String(n).padStart(10, '0')`.
- **`LedgerEntry`** (`entry.ts:59`): `{ index, prevHash, op: 'put'|'delete'|'amendment', collection, id, version, ts, actor, payloadHash, reason?, deltaHash?, amendment? }`.
- **Chain:** `entry[0].prevHash === ''`; `entry[i].prevHash === hashEntry(entry[i-1])`. `verify()` (`store.ts:606`) checks `prevHash` continuity + `index === position`.
- **Data cross-check** (`verifyBackupIntegrity` step 2, `vault.ts:2761`): for the LATEST `put` per `(collection,id)`, recompute `envelopePayloadHash(dataEnvelope)` and compare to the entry's `payloadHash`. Deletes + amendments + non-latest puts are skipped.
- **Exports available:** `canonicalJson`, `hashEntry`, `sha256Hex` (`history/ledger/entry.js`); `envelopePayloadHash` (`history/ledger/hash.js`); `LEDGER_COLLECTION` (`history/ledger/...` constants).
- **Recipient verify** needs a `LedgerStore` → open with a history strategy (`getLedgerOrNull()` is null otherwise → verify returns trivially ok, so the test MUST use `withHistory()` to actually exercise the chain).
- **Recipient keyring** gets the `_ledger` DEK because #208 wraps every DEK recovered from the seal (`unsealDeks`). So `carryLedger` MUST add the dest `_ledger` DEK to `sealDeks`'s input.

## File structure

- **Modify:** `packages/hub/src/bundle/extract-partition.ts` — `reKeyLedger` helper + wire `carryLedger` (seal the `_ledger` DEK, write `_internal._ledger` + `ledgerHead`).
- **Test:** `packages/hub/__tests__/carry-ledger.test.ts`.
- (`adopt-partition.ts` / #208: **no change** — `_internal` import + DEK wrapping already generic.)

---

## Task 1: `reKeyLedger` — filter + re-chain + recompute payloadHash + re-encrypt

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/carry-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with the `memory()` factory (copy from `__tests__/extract-partition.test.ts`) and `withHistory` import. The source vault MUST be created with `historyStrategy: withHistory()` so it has a ledger.

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withHistory } from '../src/history/index.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import { generateDEK, decrypt } from '../src/crypto.js'
import { canonicalJson, hashEntry } from '../src/history/ledger/entry.js'
import { envelopePayloadHash } from '../src/history/ledger/hash.js'
import type { LedgerEntry } from '../src/history/ledger/entry.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { reKeyLedger, reKeyClosure } from '../src/bundle/extract-partition.js'

// ── paste memory() factory ──

interface Client { id: string; name: string; operatorUserId: string }

async function srcVault() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
  const c = await db.openVault('demo-co')
  const clients = c.collection<Client>('clients')
  const bills = c.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
  await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  await clients.put('c-2', { id: 'c-2', name: 'Shop', operatorUserId: 'ann' })   // NOT in closure
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
  return c
}

async function decryptEntries(store: NoydbStore, vault: string, ledgerDek: CryptoKey): Promise<LedgerEntry[]> {
  const ids = (await store.list(vault, '_ledger')).sort()
  const out: LedgerEntry[] = []
  for (const id of ids) {
    const env = await store.get(vault, '_ledger', id)
    out.push(JSON.parse(await decrypt(env!._iv, env!._data, ledgerDek)) as LedgerEntry)
  }
  return out
}

describe('reKeyLedger', () => {
  it('carries only closure entries, re-chained + payloadHash recomputed against re-keyed data', async () => {
    const company = await srcVault()
    const closure = new Map([['clients', new Set(['c-1'])], ['bills', new Set(['b-1'])]])
    const { collections, deks } = await reKeyClosure(company, closure)

    const ledgerDek = await generateDEK()
    const result = await reKeyLedger(company, closure, collections, ledgerDek)

    // result.entries is a { paddedIndex: EncryptedEnvelope } map; result.head is the new ledgerHead.
    const ids = Object.keys(result.entries).sort()
    expect(ids.length).toBeGreaterThan(0)

    // Decrypt the carried chain under the dest ledger DEK and verify it re-chained.
    const carried: LedgerEntry[] = []
    for (const id of ids) {
      const env = result.entries[id]!
      carried.push(JSON.parse(await decrypt(env._iv, env._data, ledgerDek)) as LedgerEntry)
    }
    // No entry about c-2 (ann's client, outside the closure).
    expect(carried.some((e) => e.id === 'c-2')).toBe(false)
    // Re-chained: index 0..N-1, genesis prevHash empty, each prevHash = hashEntry(prev).
    expect(carried[0]!.index).toBe(0)
    expect(carried[0]!.prevHash).toBe('')
    for (let i = 1; i < carried.length; i++) {
      expect(carried[i]!.index).toBe(i)
      expect(carried[i]!.prevHash).toBe(await hashEntry(carried[i - 1]!))
    }
    // Latest put's payloadHash matches the RE-KEYED envelope.
    const c1 = [...carried].reverse().find((e) => e.collection === 'clients' && e.id === 'c-1' && e.op === 'put')!
    expect(c1.payloadHash).toBe(await envelopePayloadHash(collections['clients']!['c-1']!))
    // head points at the last entry.
    expect(result.head.index).toBe(carried.length - 1)
    expect(result.head.hash).toBe(await hashEntry(carried[carried.length - 1]!))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-ledger.test.ts -t "carries only closure"`
Expected: FAIL — `reKeyLedger` not exported.

- [ ] **Step 3: Write minimal implementation**

In `extract-partition.ts`, add imports:

```ts
import { canonicalJson, hashEntry } from '../history/ledger/entry.js'
import { envelopePayloadHash } from '../history/ledger/hash.js'
import type { LedgerEntry } from '../history/ledger/entry.js'
import { LEDGER_COLLECTION } from '../history/ledger/constants.js' // verify exact path: grep "export const LEDGER_COLLECTION"
```

(Confirm `LEDGER_COLLECTION`'s module with `grep -rn "export const LEDGER_COLLECTION" packages/hub/src`.)

```ts
const paddedIndex = (n: number): string => String(n).padStart(10, '0')

export interface ReKeyLedgerResult {
  /** { paddedIndex: re-encrypted entry envelope } for backup._internal._ledger. */
  readonly entries: Record<string, EncryptedEnvelope>
  /** Recomputed ledgerHead for the carried chain ('' / index -1 when empty). */
  readonly head: { hash: string; index: number; ts: string }
}

/**
 * Build the carried `_ledger` chain for an extracted partition (#205, slice 1).
 * Filters source entries to the closure, recomputes each `payloadHash` against
 * the re-keyed data, RE-CHAINS (fresh indices + prevHash), and re-encrypts under
 * `ledgerDek`. Amendment + non-closure entries are dropped. Deltas/history deferred.
 */
export async function reKeyLedger(
  vault: Vault,
  closure: Map<string, Set<string>>,
  reKeyedCollections: Record<string, Record<string, EncryptedEnvelope>>,
  ledgerDek: CryptoKey,
): Promise<ReKeyLedgerResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const srcLedgerDek = await getDEK(LEDGER_COLLECTION)

  // 1. Load + decrypt source entries in index order.
  const ids = (await adapter.list(vaultName, LEDGER_COLLECTION)).sort()
  const srcEntries: LedgerEntry[] = []
  for (const id of ids) {
    const env = await adapter.get(vaultName, LEDGER_COLLECTION, id)
    if (!env) continue
    srcEntries.push(JSON.parse(await decrypt(env._iv, env._data, srcLedgerDek)) as LedgerEntry)
  }

  // 2. Filter to closure put/delete entries (drop amendments + out-of-closure).
  const inClosure = (collection: string, id: string): boolean =>
    closure.get(collection)?.has(id) ?? false
  const kept = srcEntries.filter(
    (e) => (e.op === 'put' || e.op === 'delete') && inClosure(e.collection, e.id),
  )

  // 3. Re-chain: fresh index 0..N-1, prevHash = hashEntry(prev), payloadHash
  //    recomputed against the re-keyed envelope for puts (deletes keep theirs;
  //    verifyBackupIntegrity does not cross-check delete payloadHashes).
  const entries: Record<string, EncryptedEnvelope> = {}
  let prevHash = ''
  let last: LedgerEntry | undefined
  for (let i = 0; i < kept.length; i++) {
    const src = kept[i]!
    const reKeyedEnv = reKeyedCollections[src.collection]?.[src.id]
    const payloadHash =
      src.op === 'put' && reKeyedEnv ? await envelopePayloadHash(reKeyedEnv) : src.payloadHash
    // Preserve op/collection/id/version/ts/actor/reason; drop deltaHash/amendment
    // (slice 1 carries no deltas). Conditionally include reason (canonicalJson
    // rejects undefined).
    const entry: LedgerEntry = {
      index: i,
      prevHash,
      op: src.op,
      collection: src.collection,
      id: src.id,
      version: src.version,
      ts: src.ts,
      actor: src.actor,
      payloadHash,
      ...(src.reason !== undefined ? { reason: src.reason } : {}),
    }
    const { iv, data } = await encrypt(canonicalJson(entry), ledgerDek)
    entries[paddedIndex(i)] = {
      _noydb: reKeyedEnv?._noydb ?? 1, _v: i + 1, _ts: entry.ts, _iv: iv, _data: data, _by: entry.actor,
    } as EncryptedEnvelope
    prevHash = await hashEntry(entry)
    last = entry
  }

  return {
    entries,
    head: last ? { hash: prevHash, index: last.index, ts: last.ts } : { hash: '', index: -1, ts: '' },
  }
}
```

(`_noydb` literal: use `NOYDB_FORMAT_VERSION` imported from `../types.js` instead of `reKeyedEnv?._noydb ?? 1` if a delete entry has no re-keyed env — cleaner; verify the import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-ledger.test.ts -t "carries only closure"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/carry-ledger.test.ts
git commit -m "feat(hub): reKeyLedger — filter + re-chain + recompute payloadHash (#205)"
```

---

## Task 2: Wire `carryLedger` into `extractPartition` (seal ledger DEK + write `_internal._ledger`)

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/carry-ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { extractPartition } from '../src/bundle/extract-partition.js'
import { readNoydbBundle, parseExtractedPartitionBody } from '../src/bundle/bundle.js'

async function bundleBody(bytes: Uint8Array) {
  const { dump } = parseExtractedPartitionBody((await readNoydbBundle(bytes)).dumpJson)
  return JSON.parse(dump) as {
    _internal?: { _ledger?: Record<string, unknown> }
    ledgerHead?: { hash: string; index: number }
  }
}

describe('extractPartition carryLedger', () => {
  it('carries _internal._ledger + ledgerHead when carryLedger: true', async () => {
    const company = await srcVault()
    const { bundleBytes } = await extractPartition(company, {
      seeds: { clients: (c) => c.operatorUserId === 'belle' },
      carryLedger: true,
    })
    const body = await bundleBody(bundleBytes)
    expect(Object.keys(body._internal?._ledger ?? {}).length).toBeGreaterThan(0)
    expect(body.ledgerHead?.hash.length).toBeGreaterThan(0)
  })

  it('omits the ledger by default', async () => {
    const company = await srcVault()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: (c) => c.operatorUserId === 'belle' } })
    const body = await bundleBody(bundleBytes)
    expect(body._internal?._ledger).toBeUndefined()
    expect(body.ledgerHead).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-ledger.test.ts -t "carries _internal._ledger"`
Expected: FAIL — `carryLedger` ignored.

- [ ] **Step 3: Write minimal implementation**

In `extractPartition`'s options type add `readonly carryLedger?: boolean`. Then, after `reKeyClosure` + the `carrySchemas` block, before `sealDeks`:

```ts
  // carryLedger (#205): mint a fresh _ledger DEK, build the carried chain,
  // and SEAL the ledger DEK alongside the data DEKs so #208 wraps it into
  // the recipient keyring (lets them decrypt + verify the chain).
  let ledgerHead: { hash: string; index: number; ts: string } | undefined
  let ledgerEntries: Record<string, EncryptedEnvelope> | undefined
  if (opts.carryLedger) {
    const ledgerDek = await generateDEK()
    const built = await reKeyLedger(vault, closure, collections, ledgerDek)
    if (built.head.index >= 0) {
      ledgerEntries = built.entries
      ledgerHead = built.head
      deks.set(LEDGER_COLLECTION, ledgerDek) // sealed with the rest → #208 wraps it
    }
  }
```

Build `_internal` merging schemas (Plan 6) + ledger, and add `ledgerHead`:

```ts
  const internalSchemas = opts.carrySchemas ? await reKeySchemas(vault, closure, deks) : {}
  const internal: Record<string, Record<string, EncryptedEnvelope>> = {}
  if (Object.keys(internalSchemas).length > 0) internal[SCHEMAS_COLLECTION] = internalSchemas
  if (ledgerEntries) internal[LEDGER_COLLECTION] = ledgerEntries
  const hasInternal = Object.keys(internal).length > 0
```

(Replace the Plan 6 `internal`/`hasInternal` lines. **Order matters:** compute `internalSchemas` AFTER the `deks.set(LEDGER_COLLECTION, ...)` is fine — `reKeySchemas` only reads data-collection DEKs. But `sealDeks(deks)` must run AFTER `deks.set(LEDGER_COLLECTION, ledgerDek)` so the ledger DEK is sealed.)

In the `backup` object add `ledgerHead` + the merged `_internal`:

```ts
  const backup = {
    _noydb_backup: NOYDB_BACKUP_VERSION,
    _compartment: vaultName,
    _exported_at: new Date().toISOString(),
    _exported_by: '',
    keyrings: {},
    collections,
    ...(hasInternal ? { _internal: internal } : {}),
    ...(ledgerHead ? { ledgerHead: { hash: ledgerHead.hash, index: ledgerHead.index, ts: ledgerHead.ts } } : {}),
  }
```

**Verify the ordering of `sealDeks`:** it must be called after `deks.set(LEDGER_COLLECTION, ledgerDek)`. Move the `const { seal, transferKey } = await sealDeks(deks)` line to AFTER the carryLedger block.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-ledger.test.ts`
Expected: PASS (reKeyLedger + carryLedger wiring). Re-run `__tests__/carry-schemas.test.ts` + `__tests__/extract-partition.test.ts` to confirm the `_internal` refactor didn't regress.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/carry-ledger.test.ts
git commit -m "feat(hub): extractPartition carryLedger — seal ledger DEK + _internal._ledger + ledgerHead (#205)"
```

---

## Task 3: GATING end-to-end — `verifyBackupIntegrity()` passes on the adopted+owned partition

**Files:**
- Test: `packages/hub/__tests__/carry-ledger.test.ts`

This is the real correctness bar. If this fails, the chain reconstruction is wrong — debug with `systematic-debugging`, do not weaken the assertion.

- [ ] **Step 1: Write the integration test**

```ts
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/bundle/adopt-partition.js'

describe('carryLedger full ceremony — verifyBackupIntegrity', () => {
  it('the recipient vault verifies the carried chain over re-keyed data', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: (c) => c.operatorUserId === 'belle' }, carryLedger: true,
    })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    // Open WITH a history strategy so the ledger is live + verifiable.
    const recipientDb = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026', historyStrategy: withHistory() })
    const vault = await recipientDb.openVault('acme')

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(true)

    // And the data is readable + FK-complete.
    expect(await vault.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
```

- [ ] **Step 2: Run + debug to green**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-ledger.test.ts -t "verifyBackupIntegrity"`
Expected: PASS with `result.ok === true`. Likely failure modes + where to look:
- `kind: 'chain'` divergence → re-chaining bug (prevHash/index) in `reKeyLedger` Task 1.
- `kind: 'data'` mismatch → `payloadHash` not recomputed against the carried envelope, OR the recipient's `_ledger` DEK differs from the one entries were encrypted under (confirm `deks.set(LEDGER_COLLECTION, ledgerDek)` ran BEFORE `sealDeks`, so #208 wrapped the same DEK).
- `verify` returns trivially `ok` with `length: 0` → the recipient opened WITHOUT `withHistory()` (no LedgerStore), so the chain isn't actually exercised — the test must use `withHistory()`.

- [ ] **Step 3: Full verification**

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/extract-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/__tests__/carry-ledger.test.ts
git commit -m "test(hub): carryLedger verifyBackupIntegrity passes over re-keyed data (#205)"
```

---

## Out of scope (follow-ups)

- **`_ledger_deltas` + `_history` carry** — slice 2. Deltas are encrypted historical versions with their own `deltaHash` (referenced by entries); carrying them means re-keying each delta envelope and re-deriving `deltaHash` in the re-chained entries. File a follow-up.
- **Amendment entries** — multi-record audit entries (empty `collection`/`id`); dropped in slice 1. Revisit if a real use case needs them carried.
- **#226 lifecycle ledger entries** — now that `carryLedger` gives the destination a chain, #226's `creation-of-new-owner` / `transfer-seal-consumed` entries can append to it (the previously-noted blocker).

## Self-review notes

- **Spec coverage (#205 slice 1):** `carryLedger: true` carries closure `_ledger` entries re-keyed + re-chained; default off omits them; the carried chain passes `verifyBackupIntegrity()` over re-keyed data (the gating Task 3 test). Deltas/history explicitly deferred.
- **Recipient side reused unchanged:** `adoptPartition` `_internal` import (Plan 6) + #208 DEK wrapping (Plan 5) — `carryLedger` only adds the ledger DEK to the sealed set and the `_internal._ledger` + `ledgerHead` payload.
- **Two ordering invariants the implementation MUST hold** (called out in Task 2): (1) `sealDeks(deks)` runs AFTER `deks.set(LEDGER_COLLECTION, ledgerDek)`; (2) `payloadHash` recomputed against the SAME re-keyed envelope that lands in `collections` (so the recipient's data cross-check matches).
- **Risk acknowledged:** this is hash-chain reconstruction. Task 3's `verifyBackupIntegrity` is the non-negotiable gate; a green Task 1/2 with a red Task 3 means the chain is internally plausible but wrong against real data — debug, don't weaken.
```
