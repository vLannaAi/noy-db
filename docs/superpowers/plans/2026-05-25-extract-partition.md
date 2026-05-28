# `extractPartition` + Transfer Seal — Implementation Plan (Plan 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `extractPartition(vault, opts)` (#203 + #206) — walk the FK closure, re-encrypt the selected records under fresh per-collection DEKs, seal those DEKs under a minted one-time transfer key, and serialize an unowned `extracted-partition` bundle. Returns `{ bundleBytes, transferKey, sealId }`.

**Architecture:** A new `packages/hub/src/bundle/extract-partition.ts`. It reuses Plan 1 (`walkClosure`), Plan 3a (`ExtractedPartitionBody`, `TransferSealPayload`, the header fields), and the existing crypto (`decrypt`/`encrypt`/`generateDEK`). The container assembly currently inlined in `writeNoydbBundle` is factored into a shared internal `assembleBundleContainer` so both writers share one code path. The fresh DEKs are exported to raw bytes and sealed *as a set* under a random 32-byte transfer key (no destination KEK — see Plan 3a). The output dump JSON is a `VaultBackup` with empty `keyrings` and re-keyed `collections`.

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (bundle subsystem, `crypto.ts`, `Vault`).

---

## Epic context

**Plan 3b of the Transferable Partition Bundles epic** (spec: `docs/superpowers/specs/2026-05-24-transferable-partition-bundles-design.md`). Plans 1, 2, 3a are in PR #225. This plan is the extraction *logic*; 3a delivered the wire format it targets. After this, the bundle is produced but unowned; #207 adopts, #208 creates the owner, #209 destroys the seal.

## Confirmed facts (grounded in tree)

- **Re-key a record:** `decrypt(env._iv, env._data, srcDEK)` → plaintext; `encrypt(plaintext, destDEK)` → `{ iv, data }`; new envelope = `{ ...env, _iv: iv, _data: data }`. Preserves `_ts`/`_by`/`_tier`. (`crypto.ts:124/144`.)
- **Source DEK:** `vault._introspectState().getDEK(collectionName)` → `Promise<CryptoKey>`. Raw envelope: `adapter.get(name, collection, id)`. (`vault.ts:2405`.)
- **Fresh DEK:** `generateDEK()` returns an *extractable* AES-GCM key (`crypto.ts:80`); raw bytes via `crypto.subtle.exportKey('raw', dek)` → `bufferToBase64`.
- **Owner check:** `vault.role` getter (`vault.ts:943`) returns the caller's `Role`.
- **Dump shape:** `VaultBackup` = `{ _noydb_backup, _compartment, _exported_at, _exported_by, keyrings, collections, _internal?, ledgerHead? }` (`types.ts:672`).
- **Container assembly:** `writeNoydbBundle` (`bundle.ts:1067`) builds prefix + header + compressed body using module-private `selectCompression`/`pumpThroughStream`/`sha256Hex`/`writeUint32BE`/`concatBytes`. Task 1 factors this out.

## File structure

- **Modify:** `packages/hub/src/bundle/bundle.ts` — factor `assembleBundleContainer`; export it (internal); `writeNoydbBundle` delegates.
- **Create:** `packages/hub/src/bundle/extract-partition.ts` — re-key helper, seal helper, `extractPartition`. ~160 LOC.
- **Modify:** `packages/hub/src/bundle/index.ts` — export `extractPartition` + types.
- **Test:** `packages/hub/__tests__/extract-partition.test.ts`.

---

## Task 1: Factor `assembleBundleContainer` out of `writeNoydbBundle`

**Files:**
- Modify: `packages/hub/src/bundle/bundle.ts`
- Test: existing `packages/hub/__tests__/*bundle*` suites (regression — no new test; this is a no-behavior-change refactor verified by the existing round-trip suite).

- [ ] **Step 1: Write the implementation (refactor)**

In `bundle.ts`, add an exported internal helper just above `writeNoydbBundle`:

```ts
/**
 * Assemble the final `.noydb` container bytes from a body JSON string +
 * header extras. Shared by `writeNoydbBundle` and `extractPartition`
 * so both producers go through one compress/hash/prefix path.
 *
 * @internal
 */
export async function assembleBundleContainer(opts: {
  handle: string
  bodyJsonStr: string
  compression: WriteNoydbBundleOptions['compression']
  /** Header fields beyond the always-present four (publicEnvelope, autoUnlock, bundleKind, transferSeal). */
  headerExtras?: Partial<Pick<NoydbBundleHeader, 'publicEnvelope' | 'autoUnlock' | 'bundleKind' | 'transferSeal'>>
}): Promise<Uint8Array> {
  const dumpBytes = new TextEncoder().encode(opts.bodyJsonStr)
  const { format, streamFormat } = selectCompression(opts.compression)
  const body = streamFormat === null
    ? dumpBytes
    : await pumpThroughStream(dumpBytes, new CompressionStream(streamFormat))
  const bodySha256 = await sha256Hex(body)

  const header: NoydbBundleHeader = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle: opts.handle,
    bodyBytes: body.length,
    bodySha256,
    ...(opts.headerExtras?.publicEnvelope !== undefined ? { publicEnvelope: opts.headerExtras.publicEnvelope } : {}),
    ...(opts.headerExtras?.autoUnlock !== undefined ? { autoUnlock: opts.headerExtras.autoUnlock } : {}),
    ...(opts.headerExtras?.bundleKind !== undefined ? { bundleKind: opts.headerExtras.bundleKind } : {}),
    ...(opts.headerExtras?.transferSeal !== undefined ? { transferSeal: opts.headerExtras.transferSeal } : {}),
  }
  const headerBytes = encodeBundleHeader(header)

  const prefix = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES)
  prefix.set(NOYDB_BUNDLE_MAGIC, 0)
  prefix[4] = (streamFormat === null ? 0 : FLAG_COMPRESSED) | FLAG_HAS_INTEGRITY_HASH
  prefix[5] = format
  writeUint32BE(prefix, 6, headerBytes.length)

  return concatBytes([prefix, headerBytes, body])
}
```

Then replace the tail of `writeNoydbBundle` (from `const { format, streamFormat } = selectCompression(...)` through the final `return concatBytes(...)`) with:

```ts
  const publicEnvelope = await vault.getPublicEnvelope()
  return assembleBundleContainer({
    handle,
    bodyJsonStr,
    compression: opts.compression,
    headerExtras: {
      ...(publicEnvelope !== undefined ? { publicEnvelope } : {}),
      ...(autoUnlockMode !== null ? { autoUnlock: autoUnlockMode } : {}),
    },
  })
```

(Note: `bodyJsonStr` already exists in `writeNoydbBundle`. Remove the now-dead `dumpBytes`/`body`/`bodySha256`/`header`/`headerBytes`/`prefix` locals it replaces.)

- [ ] **Step 2: Run the existing bundle suites to verify no behavior change**

Run: `cd packages/hub && pnpm vitest run __tests__/bundle.test.ts __tests__/bundle-plaintext-filters.test.ts __tests__/extracted-partition-format.test.ts`
Expected: PASS — byte-identical output means existing round-trip + integrity tests are unaffected. (If `bundle.test.ts` is named differently, run `pnpm vitest run -t "writeNoydbBundle"`.)

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts
git commit -m "refactor(hub): factor assembleBundleContainer out of writeNoydbBundle (#203 prep)"
```

---

## Task 2: Re-key helper — re-encrypt closure records under fresh DEKs

**Files:**
- Create: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/extract-partition.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file. Copy the `memory()` factory from `__tests__/walk-closure.test.ts`.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import { decrypt } from '../src/crypto.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { reKeyClosure } from '../src/bundle/extract-partition.js'

// ── paste memory() factory ──

interface Client { id: string; name: string; operatorUserId: string }

describe('reKeyClosure', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('re-encrypts each closure record under a fresh DEK that decrypts to the same plaintext', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Acme', operatorUserId: 'belle' })

    const closure = new Map([['clients', new Set(['c-1'])]])
    const { collections, deks } = await reKeyClosure(company, closure)

    // The re-keyed envelope must NOT decrypt under a wrong key, but MUST
    // decrypt under the fresh dest DEK to the original plaintext.
    const env = collections['clients']!['c-1']!
    const destDek = deks.get('clients')!
    const plaintext = await decrypt(env._iv, env._data, destDek)
    expect(JSON.parse(plaintext)).toMatchObject({ id: 'c-1', name: 'Acme', operatorUserId: 'belle' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts -t "re-encrypts"`
Expected: FAIL — `Cannot find module '../src/bundle/extract-partition.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/hub/src/bundle/extract-partition.ts
/**
 * Partition extraction (#203 + #206). Walks the FK closure, re-encrypts
 * the selected records under fresh per-collection DEKs, seals those DEKs
 * under a one-time transfer key, and serializes an unowned
 * `extracted-partition` bundle.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import type { EncryptedEnvelope } from '../types.js'
import { decrypt, encrypt, generateDEK, bufferToBase64 } from '../crypto.js'

/** Re-keyed collections snapshot + the fresh DEKs used (in DEK-export order). */
export interface ReKeyResult {
  readonly collections: Record<string, Record<string, EncryptedEnvelope>>
  readonly deks: Map<string, CryptoKey>
}

/**
 * Re-encrypt every record in `closure` under a fresh per-collection DEK.
 * Reads raw source envelopes, decrypts under the source DEK, re-encrypts
 * under the new DEK. Plaintext-pipeline: requires an unlocked vault.
 */
export async function reKeyClosure(
  vault: Vault,
  closure: Map<string, Set<string>>,
): Promise<ReKeyResult> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const collections: Record<string, Record<string, EncryptedEnvelope>> = {}
  const deks = new Map<string, CryptoKey>()

  for (const [collectionName, ids] of closure) {
    const srcDek = await getDEK(collectionName)
    const destDek = await generateDEK()
    deks.set(collectionName, destDek)
    const out: Record<string, EncryptedEnvelope> = {}

    for (const id of ids) {
      const env = await adapter.get(vaultName, collectionName, id)
      if (!env) continue
      const plaintext = await decrypt(env._iv, env._data, srcDek)
      const { iv, data } = await encrypt(plaintext, destDek)
      out[id] = { ...env, _iv: iv, _data: data }
    }
    collections[collectionName] = out
  }

  return { collections, deks }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/extract-partition.test.ts
git commit -m "feat(hub): reKeyClosure — re-encrypt closure under fresh DEKs (#203)"
```

---

## Task 3: Seal the DEK set under a minted transfer key

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/extract-partition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { sealDeks } from '../src/bundle/extract-partition.js'
import { base64ToBuffer } from '../src/crypto.js'

describe('sealDeks', () => {
  it('seals DEKs under a 32-byte transfer key; payload decrypts back to the DEK set', async () => {
    const { generateDEK } = await import('../src/crypto.js')
    const deks = new Map([['clients', await generateDEK()], ['bills', await generateDEK()]])

    const { seal, transferKey } = await sealDeks(deks)

    expect(transferKey.byteLength).toBe(32)
    expect(seal.v).toBe(1)
    expect(seal.alg).toBe('aes-256-gcm-pre-shared')
    expect(typeof seal.sealId).toBe('string')
    expect(seal.sealId.length).toBeGreaterThan(0)

    // Unseal with the returned transfer key → recover a { collection: base64DEK } map.
    const key = await crypto.subtle.importKey('raw', transferKey, 'AES-GCM', false, ['decrypt'])
    const raw = base64ToBuffer(seal.payload)
    const iv = raw.slice(0, 12)
    const ct = raw.slice(12)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    const map = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>
    expect(Object.keys(map).sort()).toEqual(['bills', 'clients'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts -t "seals DEKs"`
Expected: FAIL — `sealDeks` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `extract-partition.ts`. Import the body type:

```ts
import type { TransferSealPayload } from './bundle.js'
```

```ts
/** A minted transfer key (raw 32 bytes) + the seal carrying the DEK set. */
export interface SealResult {
  readonly seal: TransferSealPayload
  readonly transferKey: Uint8Array
}

/**
 * Mint a random 32-byte transfer key, export each DEK to raw bytes, and
 * AES-256-GCM-seal the `{ collection: base64(rawDEK) }` map under the
 * transfer key. The transfer key is returned to the caller out-of-band;
 * only the sealed bytes travel in the bundle. Layout: iv(12) ‖ ct ‖ tag.
 */
export async function sealDeks(deks: Map<string, CryptoKey>): Promise<SealResult> {
  const dekMap: Record<string, string> = {}
  for (const [collection, dek] of deks) {
    const raw = await crypto.subtle.exportKey('raw', dek)
    dekMap[collection] = bufferToBase64(raw)
  }

  const transferKey = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', transferKey, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(dekMap))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  const combined = new Uint8Array(iv.byteLength + ct.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ct), iv.byteLength)

  const sealId = bufferToBase64(crypto.getRandomValues(new Uint8Array(12)))
  return {
    seal: { v: 1, alg: 'aes-256-gcm-pre-shared', sealId, payload: bufferToBase64(combined) },
    transferKey,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts`
Expected: PASS (re-key + seal).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/extract-partition.test.ts
git commit -m "feat(hub): sealDeks — mint transfer key + seal DEK set (#206)"
```

---

## Task 4: `extractPartition` orchestration (owner-gated, end-to-end)

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Modify: `packages/hub/src/bundle/index.ts`
- Test: `packages/hub/__tests__/extract-partition.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { extractPartition } from '../src/bundle/extract-partition.js'
import { readNoydbBundleHeader } from '../src/bundle/bundle.js'

describe('extractPartition', () => {
  let db: Noydb
  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
  })

  it('produces an extracted-partition bundle with bundleKind + transferSeal header', async () => {
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    const bills = company.collection<{ id: string; clientId: string }>(
      'bills', { refs: { clientId: ref('clients') } },
    )
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
    await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })

    const { bundleBytes, transferKey, sealId } = await extractPartition(company, {
      seeds: { clients: (c) => c['operatorUserId'] === 'belle' },
    })

    expect(transferKey.byteLength).toBe(32)
    expect(sealId.length).toBeGreaterThan(0)

    const header = await readNoydbBundleHeader(bundleBytes)
    expect(header.bundleKind).toBe('extracted-partition')
    expect(header.transferSeal?.sealId).toBe(sealId)
    expect(header.transferSeal?.alg).toBe('aes-256-gcm-pre-shared')
  })

  it('rejects a non-owner caller', async () => {
    // Grant an operator and re-open as them. (Adjust the grant API to the
    // codebase: db.grant / company.grant — see team/keyring tests.)
    const company = await db.openVault('demo-co')
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })

    // Re-open the vault under a non-owner role by constructing a keyring
    // with role 'operator'. The minimal check: extractPartition reads
    // vault.role and throws unless 'owner'.
    // (If a grant helper is unavailable in this harness, assert the guard
    // via a unit on the role gate; see Step 3's PartitionExtractionError.)
    const fakeNonOwner = Object.create(company) as typeof company
    Object.defineProperty(fakeNonOwner, 'role', { get: () => 'operator' })
    await expect(
      extractPartition(fakeNonOwner, { seeds: { clients: () => true } }),
    ).rejects.toThrow(/owner/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts -t "extracted-partition bundle"`
Expected: FAIL — `extractPartition` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `extract-partition.ts`. Imports:

```ts
import { walkClosure, type WalkClosureOptions } from './walk-closure.js'
import { assembleBundleContainer, buildExtractedPartitionWrapper } from './bundle.js'
import { PartitionExtractionError } from '../errors.js'
import { NOYDB_BACKUP_VERSION } from '../types.js'
```

```ts
export interface ExtractPartitionResult {
  readonly bundleBytes: Uint8Array
  /** Raw 32-byte transfer key — deliver out-of-band; required to adopt. */
  readonly transferKey: Uint8Array
  readonly sealId: string
}

/**
 * Extract a re-keyed, transfer-sealed partition (#203 + #206). Owner-only
 * (#198 invariant 5): producing a standalone re-keyed vault is an
 * ownership operation. Non-destructive on the source.
 */
export async function extractPartition(
  vault: Vault,
  opts: WalkClosureOptions & { readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none' },
): Promise<ExtractPartitionResult> {
  if (vault.role !== 'owner') {
    throw new PartitionExtractionError(
      `extractPartition requires the 'owner' role on the source vault; caller is '${vault.role}'. `
      + `Producing a re-keyed standalone partition is an ownership operation.`,
    )
  }

  const { closure } = await walkClosure(vault, opts)
  const { collections, deks } = await reKeyClosure(vault, closure)
  const { seal, transferKey } = await sealDeks(deks)

  // Build the dump JSON: unowned (empty keyrings), empty ledger (default),
  // re-keyed collections only.
  const { name: vaultName } = vault._introspectState()
  const backup = {
    _noydb_backup: NOYDB_BACKUP_VERSION,
    _compartment: vaultName,
    _exported_at: new Date().toISOString(),
    _exported_by: '', // unowned — no source user travels
    keyrings: {},
    collections,
  }
  const bodyJsonStr = JSON.stringify(buildExtractedPartitionWrapper(JSON.stringify(backup), seal))

  const handle = await vault.getBundleHandle()
  const bundleBytes = await assembleBundleContainer({
    handle,
    bodyJsonStr,
    compression: opts.compression,
    headerExtras: {
      bundleKind: 'extracted-partition',
      transferSeal: { v: seal.v, alg: seal.alg, sealId: seal.sealId }, // indicator only
    },
  })

  return { bundleBytes, transferKey, sealId: seal.sealId }
}
```

In `bundle/index.ts`, extend the partition-extraction export block:

```ts
export { extractPartition } from './extract-partition.js'
export type { ExtractPartitionResult } from './extract-partition.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts`
Expected: PASS (re-key, seal, header round-trip, non-owner rejection).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/src/bundle/index.ts packages/hub/__tests__/extract-partition.test.ts
git commit -m "feat(hub): extractPartition — owner-gated re-key + seal + write (#203/#206)"
```

---

## Task 5: End-to-end — read the bundle back, unseal DEKs, decrypt a record

**Files:**
- Modify: `packages/hub/__tests__/extract-partition.test.ts`

- [ ] **Step 1: Write the failing/integration test**

```ts
import { readNoydbBundle } from '../src/bundle/bundle.js'
import { parseExtractedPartitionBody } from '../src/bundle/bundle.js'

describe('extractPartition end-to-end', () => {
  it('round-trips: unseal DEKs with the transfer key, decrypt a re-keyed record', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: () => true },
    })

    // readNoydbBundle returns the body JSON string for an extracted bundle
    // (the ExtractedPartitionBody wrapper). Parse it to get dump + seal.
    const { dumpJson } = await readNoydbBundle(bundleBytes)
    const { dump, seal } = parseExtractedPartitionBody(dumpJson)
    const backup = JSON.parse(dump) as { keyrings: Record<string, unknown>; collections: Record<string, Record<string, EncryptedEnvelope>> }

    // Unowned: empty keyring.
    expect(Object.keys(backup.keyrings)).toEqual([])

    // Unseal the DEK set with the transfer key.
    const key = await crypto.subtle.importKey('raw', transferKey, 'AES-GCM', false, ['decrypt'])
    const raw = base64ToBuffer(seal.payload)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))
    const dekMap = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>

    // Import the clients DEK + decrypt the re-keyed record.
    const clientsDekRaw = base64ToBuffer(dekMap['clients']!)
    const clientsDek = await crypto.subtle.importKey('raw', clientsDekRaw, 'AES-GCM', false, ['decrypt'])
    const env = backup.collections['clients']!['c-1']!
    const recordJson = await decrypt(env._iv, env._data, clientsDek)
    expect(JSON.parse(recordJson)).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
```

- [ ] **Step 2: Run test to verify behavior**

Run: `cd packages/hub && pnpm vitest run __tests__/extract-partition.test.ts -t "round-trips"`
Expected: It may FAIL if `readNoydbBundle` does not return the wrapper string for an extracted bundle (it currently only special-cases `autoUnlock`). If so, that is the wiring gap — fix in Step 3.

- [ ] **Step 3: Wire `readNoydbBundle` for extracted bundles (only if Step 2 failed)**

In `bundle.ts`, `readNoydbBundle` decompresses the body to a string, then branches on `header.autoUnlock`. Add a branch: when `header.bundleKind === 'extracted-partition'`, return the body string as `dumpJson` **without** attempting auto-unlock parsing (the caller uses `parseExtractedPartitionBody`). Concretely, ensure the extracted-partition body string is returned verbatim in `dumpJson` and the autoUnlock parser is NOT invoked (guard the existing `if (header.autoUnlock)` branch with `&& header.bundleKind !== 'extracted-partition'`, which is already guaranteed by the mutual-exclusion invariant but make the read path explicit). Add a short comment referencing #207 (full adoption consumes this).

- [ ] **Step 4: Run the full suite**

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/extract-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green (prior count + new extract-partition tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/bundle.ts packages/hub/__tests__/extract-partition.test.ts
git commit -m "feat(hub): extractPartition end-to-end round-trip + read wiring (#203/#206)"
```

---

## Out of scope for this plan (later)

- **`carrySchemas` / `carryLedger`** (#204/#205) — this plan ships the empty-ledger, no-schemas default. Opt-ins are their own plan.
- **Source-side delete** — out of scope for the whole ceremony (spec §1).
- **`adoptPartition`** (#207) — consumes this bundle; next plan. The end-to-end test here unseals manually to prove the format is sound; #207 makes it a first-class API.
- **`features.yaml` + docs** — register `extractPartition` + `describeExtraction` together once the read path is user-facing (with #207, the consumer).
- **Source `partition-handed-over` ledger entry** (spec §4.2) — write it in the #207/owner-side plan where the ledger-write context is established, OR add here if the source ledger API is trivially available; flagged so it is not lost.

## Self-review notes

- **Spec coverage:** #203 (re-key + bundle write, empty keyring/ledger, `bundleKind` header) + #206 (transfer seal, `{ bundleBytes, transferKey, sealId }`, seal-DEKs-directly). Owner-only gate = #198 invariant 5.
- **Type consistency:** `TransferSealPayload` (from Plan 3a, `bundle.ts`) reused by `sealDeks`; the header `transferSeal` indicator is built from `seal.{v,alg,sealId}` (no payload). `WalkClosureOptions` reused for `seeds`/`maxDepth`.
- **Crypto note:** `sealDeks` uses raw WebCrypto (`crypto.subtle`) rather than `crypto.ts`'s `encrypt` because it seals *bytes* under a raw key, not a string under a DEK — and it controls the iv‖ct layout `adoptPartition` will parse. Re-keying uses the existing `encrypt`/`decrypt` string helpers.
- **Non-destructive:** no `adapter.put`/`delete` on the source anywhere in `extractPartition`.
- **Open wiring risk flagged** (Task 5 Step 3): `readNoydbBundle`'s extracted-partition branch — verified empirically by the round-trip test, not assumed.
```
