/**
 * `_blob_intent` marker plumbing (#753 blob durability journal, Task 2 of
 * PR-1 — spec §7 C5/C8/C9/C11, Q3).
 *
 * Three areas, mirroring the `history-at-rest.test.ts` "bare adapter +
 * hand-derived DEK" pattern for the primitive-level tests (no `createNoydb`
 * needed — `createIntent`/`getIntent`/`deleteIntent`/`sweepBlobIntents` are
 * plain functions over a `NoydbStore` + a `getDEK` closure):
 *
 *  - create-if-absent refusal (C8): a second `createIntent` on the same
 *    `{collection}::{recordId}` throws `BlobIntentPendingError`.
 *  - codec round-trip: encrypt → decrypt a `BlobIntent` (incl. `holds` with
 *    `chunkCount`, C5) comes back byte-identical.
 *  - sweep: `sweepBlobIntents` lists every persisted marker and resumes
 *    each via a stub `resume` callback (the real resume logic is Task 3 /
 *    PR-2 — this only proves the listing/decode/dispatch plumbing).
 *
 * The backup-allowlist test (Q3) instead goes through a real
 * `createNoydb`/`vault.dump()` — mirrors `bundle-blobs-roundtrip.test.ts`'s
 * "this internal collection travels in the bundle" pattern.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { BlobIntentPendingError, ConflictError } from '../src/kernel/errors.js'
import { generateDEK, type EnclaveKey } from '../src/kernel/enclave/index.js'
import {
  BLOB_INTENT_COLLECTION,
  createIntent,
  getIntent,
  deleteIntent,
  sweepBlobIntents,
  type BlobIntent,
} from '../src/with-shape/blobs/blob-intent.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

const VAULT = 'v'

/** Minimal in-memory NoydbStore — mirrors `history-at-rest.test.ts`'s `memory()`. */
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(v: string, col: string) {
    let vm = store.get(v)
    if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(col)
    if (!cm) { cm = new Map(); vm.set(col, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, col, id) { return store.get(v)?.get(col)?.get(id) ?? null },
    async put(v, col, id, env, ev) {
      const coll = getCollection(v, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, col, id) { store.get(v)?.get(col)?.delete(id) },
    async list(v, col) { const coll = store.get(v)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(v) {
      const vm = store.get(v); const s: VaultSnapshot = {}
      if (vm) for (const [n, coll] of vm) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(v, data) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) cm.set(id, env)
        vm.set(name, cm)
      }
      store.set(v, vm)
    },
  }
}

const sampleIntent: BlobIntent = {
  op: 'shred',
  opId: 'opid-1',
  ownerTier: 1,
  holds: [
    { eTag: 'etag-a', n: 1, chunkCount: 3 },
    { eTag: 'etag-b', n: 2, chunkCount: 1 },
  ],
}

describe('createIntent — CAS create-if-absent (#753 spec §7 C8)', () => {
  it('a second createIntent on the same {collection}::{recordId} throws BlobIntentPendingError', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    await createIntent(store, VAULT, 'docs', 'rec-1', getDEK, sampleIntent)

    await expect(
      createIntent(store, VAULT, 'docs', 'rec-1', getDEK, { ...sampleIntent, opId: 'opid-2' }),
    ).rejects.toBeInstanceOf(BlobIntentPendingError)

    // The FIRST marker is untouched — a lost race never clobbers the pending op.
    const pending = await getIntent(store, VAULT, 'docs', 'rec-1', getDEK)
    expect(pending?.opId).toBe('opid-1')
  })

  it('createIntent for a DIFFERENT record does not collide', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    await createIntent(store, VAULT, 'docs', 'rec-1', getDEK, sampleIntent)
    await expect(
      createIntent(store, VAULT, 'docs', 'rec-2', getDEK, { ...sampleIntent, opId: 'opid-2' }),
    ).resolves.toBeUndefined()
  })

  it('deleteIntent clears the marker so a subsequent createIntent succeeds', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    await createIntent(store, VAULT, 'docs', 'rec-1', getDEK, sampleIntent)
    await deleteIntent(store, VAULT, 'docs', 'rec-1')
    expect(await getIntent(store, VAULT, 'docs', 'rec-1', getDEK)).toBeNull()

    await expect(
      createIntent(store, VAULT, 'docs', 'rec-1', getDEK, { ...sampleIntent, opId: 'opid-3' }),
    ).resolves.toBeUndefined()
    expect((await getIntent(store, VAULT, 'docs', 'rec-1', getDEK))?.opId).toBe('opid-3')
  })
})

describe('codec round-trip — encrypt under getDEK(collection), decrypt back (spec §4)', () => {
  it('a BlobIntent with holds (incl. chunkCount) survives encrypt → decrypt byte-identical', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    await createIntent(store, VAULT, 'invoices', 'inv-1', getDEK, sampleIntent)

    // The raw envelope is genuinely encrypted — never plaintext JSON on the wire.
    const raw = await store.get(VAULT, BLOB_INTENT_COLLECTION, 'invoices::inv-1')
    expect(raw).not.toBeNull()
    expect(raw!._data).not.toContain('opid-1')
    expect(raw!._iv).not.toBe('')

    const decoded = await getIntent(store, VAULT, 'invoices', 'inv-1', getDEK)
    expect(decoded).toEqual(sampleIntent)
  })

  it('a rehome-shaped intent (fromTier/toTier/policy, no holds) round-trips too', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const rehome: BlobIntent = { op: 'rehome', opId: 'rehome-1', fromTier: 0, toTier: 2, policy: 'isolate' }
    await createIntent(store, VAULT, 'docs', 'rec-9', getDEK, rehome)
    expect(await getIntent(store, VAULT, 'docs', 'rec-9', getDEK)).toEqual(rehome)
  })

  it('the wrong DEK cannot decrypt the marker', async () => {
    const store = memory()
    const dek = await generateDEK()
    const wrongDek: EnclaveKey = await generateDEK()

    await createIntent(store, VAULT, 'docs', 'rec-1', async () => dek, sampleIntent)
    await expect(getIntent(store, VAULT, 'docs', 'rec-1', async () => wrongDek)).rejects.toThrow()
  })
})

describe('sweepBlobIntents — lists + resumes every pending marker', () => {
  it('resumes every persisted marker exactly once, with the parsed collection/recordId + decoded intent', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const rehome: BlobIntent = { op: 'rehome', opId: 'op-r', fromTier: 0, toTier: 1, policy: 'dedup' }
    await createIntent(store, VAULT, 'docs', 'rec-1', getDEK, sampleIntent)
    await createIntent(store, VAULT, 'invoices', 'inv-9', getDEK, rehome)

    const resumed: Array<{ collection: string; recordId: string; intent: BlobIntent }> = []
    await sweepBlobIntents(store, VAULT, getDEK, async (collection, recordId, intent) => {
      resumed.push({ collection, recordId, intent })
    })

    expect(resumed).toHaveLength(2)
    const byRecord = new Map(resumed.map((r) => [`${r.collection}::${r.recordId}`, r.intent]))
    expect(byRecord.get('docs::rec-1')).toEqual(sampleIntent)
    expect(byRecord.get('invoices::inv-9')).toEqual(rehome)
  })

  it('an empty _blob_intent collection resumes nothing (the zero-cost normal path)', async () => {
    const store = memory()
    const dek = await generateDEK()
    let calls = 0
    await sweepBlobIntents(store, VAULT, async () => dek, async () => { calls++ })
    expect(calls).toBe(0)
  })
})

describe('backup allowlist — _blob_intent travels in the bundle (#753 spec §7 Q3)', () => {
  const SECRET = 'correct-horse-battery-staple-long-enough'

  it('a pending marker is present in vault.dump()\'s _internal section', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, blobStrategy: withBlobs(), historyStrategy: withHistory() })
    const vault = await db.openVault('demo-co')
    const docs = vault.collection<{ title: string }>('docs')
    await docs.put('rec-1', { title: 'hello' })

    // Write the marker directly against the SAME underlying store/vault name
    // dump() reads from — dump() copies raw envelopes without decrypting
    // them, so any valid envelope (any DEK) proves the allowlist wiring,
    // independent of the vault's own key material.
    const dek = await generateDEK()
    await createIntent(store, 'demo-co', 'docs', 'rec-1', async () => dek, sampleIntent)

    const backupJson = await vault.dump()
    const backup = JSON.parse(backupJson)
    expect(backup._internal).toBeDefined()
    expect(backup._internal[BLOB_INTENT_COLLECTION]).toBeDefined()
    expect(backup._internal[BLOB_INTENT_COLLECTION]['docs::rec-1']).toBeDefined()

    db.close()
  })

  it('a vault with no pending markers omits _blob_intent from the bundle', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, blobStrategy: withBlobs(), historyStrategy: withHistory() })
    const vault = await db.openVault('demo-co')
    const docs = vault.collection<{ title: string }>('docs')
    await docs.put('rec-1', { title: 'hello' })

    const backupJson = await vault.dump()
    const backup = JSON.parse(backupJson)
    expect(backup._internal?.[BLOB_INTENT_COLLECTION]).toBeUndefined()

    db.close()
  })
})
