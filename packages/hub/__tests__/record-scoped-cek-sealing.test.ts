/**
 * Record-scoped CEK sealing to an at-* host (#306 slices 2-3).
 *
 * Spec: docs/superpowers/specs/2026-06-13-record-scoped-cek-sealing-design.md
 *
 * Grantor side (`vault.sealRecordToHost` / `revokeSealedRecord` /
 * `rotateRecordCek`) + host side (`openSealedRecord`). The host is a
 * `MemoryRecipientSealer` — real RSA-OAEP + AES-GCM, in-process, no AWS.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError, TamperedError } from '../src/kernel/errors.js'
import {
  SealedRecordExpiredError,
  SealedRecordMismatchError,
  RecordCekNotFoundError,
} from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { MemoryRecipientSealer } from '../src/with-party/team/managed-passphrase.js'
import { openSealedRecord, withSealedRecord } from '../src/with-audit/sealed-record/index.js'
import type { SealedCekDeliveryEnvelope } from '../src/with-audit/sealed-record/types.js'

/** In-memory store exposing raw stored envelopes for assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Doc { id: string; secret: string }

const SECRET = 'test-passphrase-1234'
const HOUR = 60 * 60 * 1000

function readDelivery(
  store: ReturnType<typeof memory>,
  vault: string,
  collection: string,
  id: string,
  pid: string,
): SealedCekDeliveryEnvelope {
  const env = store.raw(vault, '_sealed_cek', `${collection}/${id}/${pid}`)!
  return JSON.parse(env._data) as SealedCekDeliveryEnvelope
}

async function setup() {
  const store = memory()
  const db = await createNoydb({ store, user: 'alice', secret: SECRET, sealedRecordStrategy: withSealedRecord() })
  const vault = await db.openVault('v')
  const docs = vault.collection<Doc>('docs', { perRecordKeys: true })
  return { store, db, vault, docs }
}

describe('record-scoped CEK sealing — happy path', () => {
  it('seal → openSealedRecord round-trips the record body', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'the eagle lands at dawn' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid, envelopeKey } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    expect(pid).toBe('kms:host-A')
    expect(envelopeKey).toBe('docs/d-1/kms:host-A')

    const delivery = readDelivery(store, 'v', 'docs', 'd-1', pid)
    expect(delivery._noydb_sealed_cek).toBe(1)
    expect(delivery.v).toBe(1)

    const recordEnv = store.raw('v', 'docs', 'd-1')!
    const json = await openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1')
    expect(JSON.parse(json)).toMatchObject({ id: 'd-1', secret: 'the eagle lands at dawn' })
  })
})

describe('record-scoped CEK sealing — host denial', () => {
  it('a CEK sealed for record A applied to record B → SealedRecordMismatchError', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('A', { id: 'A', secret: 'alpha' })
    await docs.put('B', { id: 'B', secret: 'bravo' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'A', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })

    const deliveryForA = readDelivery(store, 'v', 'docs', 'A', pid)
    const envelopeOfB = store.raw('v', 'docs', 'B')!

    // Present A's sealed CEK against B's envelope, claiming it is B.
    await expect(
      openSealedRecord(deliveryForA, envelopeOfB, host, 'docs', 'B'),
    ).rejects.toBeInstanceOf(SealedRecordMismatchError)
  })
})

describe('record-scoped CEK sealing — expiry', () => {
  it('past expiry → SealedRecordExpiredError on the fast-path (envelope)', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() - HOUR).toISOString(), // already past
    })
    const delivery = readDelivery(store, 'v', 'docs', 'd-1', pid)
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    await expect(
      openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(SealedRecordExpiredError)
  })

  it('past expiry → SealedRecordExpiredError on the AUTHORITATIVE binding even if the envelope hint is forged-future', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() - HOUR).toISOString(), // binding is past
    })
    const delivery = readDelivery(store, 'v', 'docs', 'd-1', pid)
    // Forge the clear-text envelope expiry to a future time — the fast-path
    // would pass, but the authoritative copy inside the sealed binding is past.
    const forged: SealedCekDeliveryEnvelope = {
      ...delivery,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    }
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    await expect(
      openSealedRecord(forged, recordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(SealedRecordExpiredError)
  })
})

describe('record-scoped CEK sealing — revoke', () => {
  it('revokeSealedRecord deletes the delivery envelope', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    expect(store.raw('v', 'docs', 'd-1')).toBeDefined()
    expect(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)).toBeDefined()

    await vault.revokeSealedRecord('docs', 'd-1', pid)
    expect(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)).toBeUndefined()
  })
})

describe('record-scoped CEK sealing — rotateRecordCek (hard revocation)', () => {
  it('deletes stale sealed envelopes, re-keys the live record, and old grants lose the live record', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'v1 content' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })

    // Capture the PRE-rotation sealed CEK + PRE-rotation record envelope.
    const preDelivery = readDelivery(store, 'v', 'docs', 'd-1', pid)
    const preRecordEnv = store.raw('v', 'docs', 'd-1')!

    // The pre-rotation sealed CEK opens the pre-rotation envelope (sanity).
    const preJson = await openSealedRecord(preDelivery, preRecordEnv, host, 'docs', 'd-1')
    expect(JSON.parse(preJson)).toMatchObject({ secret: 'v1 content' })

    await vault.rotateRecordCek('docs', 'd-1')

    // Stale sealed envelope deleted.
    expect(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)).toBeUndefined()

    // The live envelope was re-keyed (new _cek, bumped _v).
    const postRecordEnv = store.raw('v', 'docs', 'd-1')!
    expect(postRecordEnv._cek).toBeDefined()
    expect(postRecordEnv._cek).not.toBe(preRecordEnv._cek)
    expect(postRecordEnv._v).toBe(preRecordEnv._v + 1)

    // The pre-rotation sealed CEK STILL opens the pre-rotation envelope
    // (history versions keep their old _cek).
    const stillPre = await openSealedRecord(preDelivery, preRecordEnv, host, 'docs', 'd-1')
    expect(JSON.parse(stillPre)).toMatchObject({ secret: 'v1 content' })

    // …but applied to the POST-rotation live envelope → TamperedError
    // (wrong-key AES-GCM auth failure, NOT a mismatch — the binding still
    // matches {collection,id}).
    await expect(
      openSealedRecord(preDelivery, postRecordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(TamperedError)

    // The vault itself still reads the live record (caches evicted).
    expect(await docs.get('d-1')).toMatchObject({ id: 'd-1', secret: 'v1 content' })
  })

  it('after rotate, collection.get(id) decrypts via the fresh CEK (cekCache evicted)', async () => {
    const { vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'before' })
    // Warm the cekCache with a read.
    expect(await docs.get('d-1')).toMatchObject({ secret: 'before' })

    await vault.rotateRecordCek('docs', 'd-1')

    // If the stale CEK were still cached, this decrypt would throw TamperedError.
    expect(await docs.get('d-1')).toMatchObject({ id: 'd-1', secret: 'before' })

    // A subsequent normal update still works (CEK is stable post-rotation).
    await docs.put('d-1', { id: 'd-1', secret: 'after' })
    expect(await docs.get('d-1')).toMatchObject({ secret: 'after' })
  })
})

describe('record-scoped CEK sealing — multiple pids', () => {
  it('revoke one pid leaves the other; rotate deletes all', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })

    const hostA = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const hostB = new MemoryRecipientSealer({ id: 'kms:host-B' })
    await vault.sealRecordToHost('docs', 'd-1', hostA, { expiresAt: new Date(Date.now() + HOUR).toISOString() })
    await vault.sealRecordToHost('docs', 'd-1', hostB, { expiresAt: new Date(Date.now() + HOUR).toISOString() })

    expect(store.raw('v', '_sealed_cek', 'docs/d-1/kms:host-A')).toBeDefined()
    expect(store.raw('v', '_sealed_cek', 'docs/d-1/kms:host-B')).toBeDefined()

    // Revoke A only.
    await vault.revokeSealedRecord('docs', 'd-1', 'kms:host-A')
    expect(store.raw('v', '_sealed_cek', 'docs/d-1/kms:host-A')).toBeUndefined()
    expect(store.raw('v', '_sealed_cek', 'docs/d-1/kms:host-B')).toBeDefined()

    // Rotate deletes all remaining.
    await vault.rotateRecordCek('docs', 'd-1')
    expect(store.raw('v', '_sealed_cek', 'docs/d-1/kms:host-B')).toBeUndefined()
  })
})

describe('record-scoped CEK sealing — cross-process reconstruction', () => {
  it('a host function given only {sealedEnv, recordEnv, sealer} reconstructs the record with NO vault DEK', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'cross-process payload' })

    const host = new MemoryRecipientSealer({ id: 'kms:remote' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })

    // Marshal ONLY the two envelopes across the "process boundary" — no DEK,
    // no keyring, no vault handle. The host keeps its own sealer (its KMS key).
    const sealedEnv = readDelivery(store, 'v', 'docs', 'd-1', pid)
    const recordEnv = { _iv: store.raw('v', 'docs', 'd-1')!._iv, _data: store.raw('v', 'docs', 'd-1')!._data }

    async function hostFunction(
      env: SealedCekDeliveryEnvelope,
      rec: { _iv: string; _data: string },
      sealer: MemoryRecipientSealer,
    ): Promise<string> {
      return openSealedRecord(env, rec, sealer, 'docs', 'd-1')
    }

    const json = await hostFunction(sealedEnv, recordEnv, host)
    expect(JSON.parse(json)).toMatchObject({ secret: 'cross-process payload' })
  })
})

describe('record-scoped CEK sealing — RecordCekNotFoundError', () => {
  it('throws for a missing record', async () => {
    const { vault } = await setup()
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    await expect(
      vault.sealRecordToHost('docs', 'nope', host, { expiresAt: new Date(Date.now() + HOUR).toISOString() }),
    ).rejects.toBeInstanceOf(RecordCekNotFoundError)
    await expect(vault.rotateRecordCek('docs', 'nope')).rejects.toBeInstanceOf(RecordCekNotFoundError)
  })

  it('throws for a non-perRecordKeys (legacy) collection — its body has no sealable _cek', async () => {
    const { vault } = await setup()
    const legacy = vault.collection<Doc>('legacy')
    await legacy.put('l-1', { id: 'l-1', secret: 'plain' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    await expect(
      vault.sealRecordToHost('legacy', 'l-1', host, { expiresAt: new Date(Date.now() + HOUR).toISOString() }),
    ).rejects.toBeInstanceOf(RecordCekNotFoundError)
  })
})
