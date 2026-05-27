# `adoptPartition` — Implementation Plan (Plan 4, #207)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `adoptPartition(bundleBytes, { transferKey, destinationStore, vaultName })` (#207) — the recipient side. Verify the bundle is an extracted, transfer-sealed partition; validate the transfer key; import the re-keyed collections into the destination store under `vaultName`; persist an `_meta/adoption` marker carrying the sealed DEK payload. After adoption the vault is present but **unowned** (#208 creates the owner; #209 destroys the seal).

**Architecture:** A new `packages/hub/src/bundle/adopt-partition.ts`. It reuses Plan 3a (`parseExtractedPartitionBody`, `TransferSealPayload`) + Plan 3b (the `iv‖ct‖tag` seal layout) and the existing bundle readers. **DEK custody decision:** `adoptPartition` unseals the DEK set *in memory only* — to validate the transfer key (wrong key → throw) — then discards it. The sealed payload is persisted verbatim in `_meta/adoption` so no plaintext DEK is ever written at rest; `createOwnerOnAdoptedPartition` (#208) re-unseals with the transfer key to wrap the DEKs under the recipient's KEK, and `#209` clears the seal afterward.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (bundle subsystem, `crypto.ts`, `NoydbStore`).

---

## Epic context

**Plan 4 of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`). Plans 1, 2, 3a, 3b are in PR #225 — the entire *producer* side. This plan is the first *consumer* step. State transition: `extracted bundle → ADOPTED, UNOWNED` (`_meta/adoption` present, keyring still empty, `needsOwner: true`).

## Confirmed facts (grounded in tree)

- **Readers:** `readNoydbBundleHeader(bytes)` → `NoydbBundleHeader`; `readNoydbBundle(bytes)` → `{ header, dumpJson }` where `dumpJson` is the body string verbatim for an extracted bundle (`autoUnlock` undefined path, `bundle.ts:1301`). `parseExtractedPartitionBody(dumpJson)` → `{ dump, seal }` (Plan 3a).
- **Seal layout (Plan 3b `sealDeks`):** `payload` = base64(`iv(12) ‖ AES-256-GCM-ct ‖ tag`), key = `transferKey` imported as AES-GCM. Unseal = reverse.
- **Store writes (`NoydbStore`, `types.ts`):** `saveAll(vault, snapshot)` bulk-writes data collections (preserves existing `_`-prefixed internal collections); `put(vault, collection, id, envelope)`; `get(vault, collection, id)`.
- **Marker-as-envelope pattern:** `vault.load` writes keyrings as `{ _noydb: 1, _v: 1, _ts, _iv: '', _data: JSON.stringify(...) }` (`vault.ts:2619`). `_meta/adoption` follows this — the adoption record is metadata (the seal inside it is already ciphertext), so `_iv: ''`, `_data` = JSON.

## File structure

- **Create:** `packages/hub/src/bundle/adopt-partition.ts` — `unsealDeks` helper + `adoptPartition`. ~110 LOC.
- **Modify:** `packages/hub/src/errors.ts` — add `TransferSealError`, `AdoptionStateError`.
- **Modify:** `packages/hub/src/bundle/index.ts` — export `adoptPartition` + types + the two errors.
- **Test:** `packages/hub/__tests__/adopt-partition.test.ts`.

---

## Task 1: `TransferSealError` + `AdoptionStateError`

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Test: `packages/hub/__tests__/adopt-partition.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with the `memory()` factory (copy from `__tests__/extract-partition.test.ts`) and:

```ts
import { describe, it, expect } from 'vitest'
import { TransferSealError, AdoptionStateError } from '../src/errors.js'

describe('partition adoption error types', () => {
  it('exposes TransferSealError and AdoptionStateError as NoydbError subclasses', () => {
    expect(new TransferSealError('x')).toBeInstanceOf(Error)
    expect(new TransferSealError('x').name).toBe('TransferSealError')
    expect(new AdoptionStateError('y').name).toBe('AdoptionStateError')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "error types"`
Expected: FAIL — neither error is exported from `errors.js`.

- [ ] **Step 3: Write minimal implementation**

In `errors.ts`, after `PartitionExtractionError`:

```ts
/**
 * Thrown by `adoptPartition` (#207) when the transfer seal can't be
 * opened — a wrong/short transfer key (AES-GCM auth-tag failure) or a
 * malformed sealed payload.
 */
export class TransferSealError extends NoydbError {
  constructor(message: string) {
    super('TRANSFER_SEAL', message)
    this.name = 'TransferSealError'
  }
}

/**
 * Thrown when an adoption-lifecycle precondition fails — re-adopting a
 * partition already consumed in this store (#207), or owner-creation on a
 * vault that isn't in the adopted-unowned state (#208).
 */
export class AdoptionStateError extends NoydbError {
  constructor(message: string) {
    super('ADOPTION_STATE', message)
    this.name = 'AdoptionStateError'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "error types"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/errors.ts packages/hub/__tests__/adopt-partition.test.ts
git commit -m "feat(hub): TransferSealError + AdoptionStateError (#207)"
```

---

## Task 2: `unsealDeks` — reverse of `sealDeks`

**Files:**
- Create: `packages/hub/src/bundle/adopt-partition.ts`
- Test: `packages/hub/__tests__/adopt-partition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { unsealDeks } from '../src/bundle/adopt-partition.js'
import { sealDeks } from '../src/bundle/extract-partition.js'
import { generateDEK } from '../src/crypto.js'
import { TransferSealError } from '../src/errors.js'

describe('unsealDeks', () => {
  it('round-trips sealDeks: recovers usable DEKs under the right transfer key', async () => {
    const original = new Map([['clients', await generateDEK()]])
    const { seal, transferKey } = await sealDeks(original)

    const deks = await unsealDeks(seal, transferKey)
    expect([...deks.keys()]).toEqual(['clients'])
    // The recovered DEK is a usable AES-GCM CryptoKey.
    expect(deks.get('clients')!.algorithm.name).toBe('AES-GCM')
  })

  it('throws TransferSealError on a wrong transfer key', async () => {
    const { seal } = await sealDeks(new Map([['c', await generateDEK()]]))
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(unsealDeks(seal, wrong)).rejects.toThrow(TransferSealError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "unsealDeks"`
Expected: FAIL — `adopt-partition.js` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/bundle/adopt-partition.ts
/**
 * Partition adoption (#207). Recipient side: verify an extracted bundle,
 * validate the transfer key, import the re-keyed collections into a
 * destination store, and record an `_meta/adoption` marker. The bundle
 * stays UNOWNED after adoption — `createOwnerOnAdoptedPartition` (#208)
 * mints the owner; `#209` destroys the seal.
 *
 * @module
 */
import { base64ToBuffer } from '../crypto.js'
import { TransferSealError } from '../errors.js'
import type { TransferSealPayload } from './bundle.js'

/**
 * Reverse of `sealDeks` (#206). Imports the transfer key, decrypts the
 * sealed `{ collection: base64(rawDEK) }` map (layout iv(12)‖ct‖tag), and
 * re-imports each DEK as an AES-GCM key. Throws `TransferSealError` on a
 * wrong key (AES-GCM auth-tag failure) or malformed payload.
 */
export async function unsealDeks(
  seal: TransferSealPayload,
  transferKey: Uint8Array,
): Promise<Map<string, CryptoKey>> {
  if (transferKey.byteLength !== 32) {
    throw new TransferSealError(
      `transfer key must be 32 bytes, got ${transferKey.byteLength}.`,
    )
  }
  const key = await crypto.subtle.importKey('raw', transferKey, 'AES-GCM', false, ['decrypt'])
  const raw = base64ToBuffer(seal.payload)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))
  } catch {
    throw new TransferSealError(
      'transfer seal could not be opened — wrong transfer key (AES-GCM authentication failed).',
    )
  }
  let dekMap: Record<string, string>
  try {
    dekMap = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>
  } catch {
    throw new TransferSealError('transfer seal payload is not valid JSON after decryption.')
  }
  const deks = new Map<string, CryptoKey>()
  for (const [collection, b64] of Object.entries(dekMap)) {
    const dek = await crypto.subtle.importKey('raw', base64ToBuffer(b64), 'AES-GCM', false, ['encrypt', 'decrypt'])
    deks.set(collection, dek)
  }
  return deks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "unsealDeks"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/adopt-partition.ts packages/hub/__tests__/adopt-partition.test.ts
git commit -m "feat(hub): unsealDeks — open the transfer seal recipient-side (#207)"
```

---

## Task 3: `adoptPartition` — happy path (import + `_meta/adoption`)

**Files:**
- Modify: `packages/hub/src/bundle/adopt-partition.ts`
- Modify: `packages/hub/src/bundle/index.ts`
- Test: `packages/hub/__tests__/adopt-partition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { adoptPartition } from '../src/bundle/adopt-partition.js'
import { extractPartition } from '../src/bundle/extract-partition.js'
import { createNoydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import type { Noydb } from '../src/noydb.js'

interface Client { id: string; name: string; operatorUserId: string }

describe('adoptPartition', () => {
  async function makeExtractedBundle() {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
    return extractPartition(company, { seeds: { clients: () => true } })
  }

  it('imports re-keyed collections + writes _meta/adoption, leaving the vault unowned', async () => {
    const { bundleBytes, transferKey, sealId } = await makeExtractedBundle()
    const dest = memory()

    const result = await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme-hotel' })

    expect(result).toEqual({ vaultName: 'acme-hotel', needsOwner: true, sealId })

    // Re-keyed collections landed in the destination store.
    expect(await dest.get('acme-hotel', 'clients', 'c-1')).toBeTruthy()
    expect(await dest.get('acme-hotel', 'bills', 'b-1')).toBeTruthy()

    // _meta/adoption marker present, needsOwner true, keyring still empty.
    const adoptionEnv = await dest.get('acme-hotel', '_meta', 'adoption')
    expect(adoptionEnv).toBeTruthy()
    const adoption = JSON.parse(adoptionEnv!._data) as { sealId: string; needsOwner: boolean; transferSeal: unknown }
    expect(adoption.sealId).toBe(sealId)
    expect(adoption.needsOwner).toBe(true)
    expect(adoption.transferSeal).toBeTruthy() // sealed DEKs persisted for #208
    expect(await dest.list('acme-hotel', '_keyring')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "imports re-keyed"`
Expected: FAIL — `adoptPartition` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `adopt-partition.ts`. Imports:

```ts
import { ValidationError } from '../errors.js'
import { AdoptionStateError } from '../errors.js'
import type { NoydbStore } from '../types.js'
import { readNoydbBundleHeader, readNoydbBundle, parseExtractedPartitionBody } from './bundle.js'
```

```ts
export interface AdoptPartitionOptions {
  readonly transferKey: Uint8Array
  readonly destinationStore: NoydbStore
  readonly vaultName: string
}

export interface AdoptPartitionResult {
  readonly vaultName: string
  readonly needsOwner: true
  readonly sealId: string
}

export async function adoptPartition(
  bundleBytes: Uint8Array,
  opts: AdoptPartitionOptions,
): Promise<AdoptPartitionResult> {
  const { transferKey, destinationStore, vaultName } = opts

  const header = await readNoydbBundleHeader(bundleBytes)
  if (header.bundleKind !== 'extracted-partition' || header.transferSeal === undefined) {
    throw new ValidationError(
      'adoptPartition requires an extracted-partition bundle with a transfer seal. '
      + 'For ordinary backups use readNoydbBundle + vault.load.',
    )
  }

  const { dumpJson } = await readNoydbBundle(bundleBytes)
  const { dump, seal } = parseExtractedPartitionBody(dumpJson)

  // Validate the transfer key by unsealing in memory; throws
  // TransferSealError on mismatch. DEKs are discarded here — they stay
  // sealed at rest (in _meta/adoption) until #208 wraps them under the
  // recipient's KEK.
  await unsealDeks(seal, transferKey)

  // One-time-per-destination: refuse to re-adopt the same partition into
  // a store that already consumed this seal.
  const existing = await destinationStore.get(vaultName, '_meta', 'adoption')
  if (existing) {
    const prior = JSON.parse(existing._data) as { sealId?: string }
    if (prior.sealId === seal.sealId) {
      throw new AdoptionStateError(
        `partition (sealId ${seal.sealId}) is already adopted into vault "${vaultName}".`,
      )
    }
  }

  const backup = JSON.parse(dump) as { collections: import('../types.js').VaultSnapshot }
  await destinationStore.saveAll(vaultName, backup.collections)

  const adoptedAt = new Date().toISOString()
  const adoption = { sealId: seal.sealId, adoptedAt, needsOwner: true as const, transferSeal: seal }
  await destinationStore.put(vaultName, '_meta', 'adoption', {
    _noydb: 1, _v: 1, _ts: adoptedAt, _iv: '', _data: JSON.stringify(adoption),
  })

  return { vaultName, needsOwner: true, sealId: seal.sealId }
}
```

In `bundle/index.ts`, extend the partition-extraction exports:

```ts
export { adoptPartition, unsealDeks } from './adopt-partition.js'
export type { AdoptPartitionOptions, AdoptPartitionResult } from './adopt-partition.js'
export { TransferSealError, AdoptionStateError } from '../errors.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "imports re-keyed"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/adopt-partition.ts packages/hub/src/bundle/index.ts packages/hub/__tests__/adopt-partition.test.ts
git commit -m "feat(hub): adoptPartition — import re-keyed bundle + _meta/adoption (#207)"
```

---

## Task 4: Rejections — wrong key, non-extracted bundle, double adoption

**Files:**
- Test: `packages/hub/__tests__/adopt-partition.test.ts`

- [ ] **Step 1: Write the failing/integration tests**

```ts
import { writeNoydbBundle } from '../src/bundle/bundle.js'

describe('adoptPartition rejections', () => {
  it('throws TransferSealError on the wrong transfer key', async () => {
    const { bundleBytes } = await makeExtractedBundle()
    const wrong = crypto.getRandomValues(new Uint8Array(32))
    await expect(
      adoptPartition(bundleBytes, { transferKey: wrong, destinationStore: memory(), vaultName: 'v' }),
    ).rejects.toThrow(TransferSealError)
  })

  it('throws ValidationError for a non-extracted (ordinary) bundle', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
    const ordinary = await writeNoydbBundle(company)
    await expect(
      adoptPartition(ordinary, { transferKey: crypto.getRandomValues(new Uint8Array(32)), destinationStore: memory(), vaultName: 'v' }),
    ).rejects.toThrow(/extracted-partition/)
  })

  it('rejects double adoption of the same partition into the same store', async () => {
    const { bundleBytes, transferKey } = await makeExtractedBundle()
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await expect(
      adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' }),
    ).rejects.toThrow(AdoptionStateError)
  })

  it('allows adopting the same partition into a DIFFERENT store (bundle is unchanged)', async () => {
    const { bundleBytes, transferKey, sealId } = await makeExtractedBundle()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: memory(), vaultName: 'a' })
    const second = await adoptPartition(bundleBytes, { transferKey, destinationStore: memory(), vaultName: 'b' })
    expect(second.sealId).toBe(sealId) // one-time is per-destination, not per-bundle
  })
})
```

Add `import { AdoptionStateError } from '../src/errors.js'` if not already imported.

- [ ] **Step 2: Run tests to verify behavior**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts -t "rejections"`
Expected: PASS — all four behaviors are implemented by Task 3's guards (no new code expected). If "double adoption" FAILS, confirm the `_meta/adoption` read precedes `saveAll` so the prior marker is visible.

- [ ] **Step 3: (no implementation if Step 2 passed)**

- [ ] **Step 4: Run the full file**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts`
Expected: PASS (all adoption tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/__tests__/adopt-partition.test.ts
git commit -m "test(hub): adoptPartition rejections — wrong key, non-extracted, double adopt (#207)"
```

---

## Task 5: End-to-end — adopted records decrypt under unsealed DEKs

**Files:**
- Test: `packages/hub/__tests__/adopt-partition.test.ts`

- [ ] **Step 1: Write the integration test**

Proves the adopted store holds records that decrypt under the DEKs recovered from the seal — the property #208 relies on.

```ts
import { unsealDeks as unseal } from '../src/bundle/adopt-partition.js'
import { decrypt } from '../src/crypto.js'
import { parseExtractedPartitionBody as parseBody } from '../src/bundle/bundle.js'
import { readNoydbBundle as readBundle } from '../src/bundle/bundle.js'

describe('adoptPartition end-to-end', () => {
  it('adopted records decrypt under the DEKs recovered from the transfer seal', async () => {
    const { bundleBytes, transferKey } = await makeExtractedBundle()
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })

    // Recover the DEKs the way #208 will: read the marker's seal, unseal.
    const { seal } = parseBody((await readBundle(bundleBytes)).dumpJson)
    const deks = await unseal(seal, transferKey)

    const env = await dest.get('acme', 'clients', 'c-1')
    const plaintext = await decrypt(env!._iv, env!._data, deks.get('clients')!)
    expect(JSON.parse(plaintext)).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
```

- [ ] **Step 2: Run + full verification**

Run: `cd packages/hub && pnpm vitest run __tests__/adopt-partition.test.ts`
Expected: PASS.

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/adopt-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green (prior count + new adoption tests).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/adopt-partition.test.ts
git commit -m "test(hub): adoptPartition end-to-end — adopted records decrypt under sealed DEKs (#207)"
```

---

## Out of scope for this plan (later)

- **`createOwnerOnAdoptedPartition`** (#208) — mints the recipient owner via `setupNewVaultIdentity` (the deferred #201 refactor), re-unseals the DEKs with the transfer key, wraps them under the recipient KEK. Next plan.
- **Seal cleanup** (#209) — clears `_meta/adoption.transferSeal` after owner creation. With #208.
- **`createNoydb({ expecting: 'adopted-partition' })`** — the explicit-flag open path (spec decision) is part of #208, where owner creation needs it.
- **`features.yaml` + docs** — register the extract/adopt pair once the ceremony is openable end-to-end (#208).

## Self-review notes

- **Spec coverage (#207):** verifies `bundleKind === 'extracted-partition'` + seal present (else `ValidationError`); unseals with the transfer key (`TransferSealError` on mismatch); imports the body into `destinationStore` under `vaultName`; writes `_meta/adoption` (sealId + adoptedAt + needsOwner + the sealed payload); double-adoption into the same store rejected (`AdoptionStateError`); re-adoption into a different store allowed (bundle unchanged). Matches #207 acceptance list.
- **DEK custody:** sealed at rest (no plaintext DEK written); in-memory unseal only validates the key. #208 re-unseals — recorded as the design rationale above.
- **Type consistency:** `unsealDeks` consumes `TransferSealPayload` (Plan 3a/3b) and is the exact inverse of `sealDeks`; the round-trip test pins this. `AdoptPartitionResult.needsOwner` is the literal `true` (the vault is always unowned post-adopt).
- **Ordering:** the `_meta/adoption` existence check runs BEFORE `saveAll`, so a double-adopt is caught before any write.
```
