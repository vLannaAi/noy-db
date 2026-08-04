/**
 * Reserved `_manifest` collection — structural gating (#941 Task 1).
 *
 * Mirrors reserved-secret-collection-leak.test.ts's Layer 1 pattern: the
 * generic public collection handle must refuse the reserved manifest
 * collection, and the manifest record must travel in a pod dump like every
 * other reserved internal collection.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { ReservedCollectionNameError } from '../../src/kernel/errors.js'
import {
  MANIFEST_COLLECTION,
  MANIFEST_RESERVED_COLLECTIONS,
  isManifestReservedCollection,
} from '../../src/with-shape/manifest/reserved-collections.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) { gc(v, c).set(id, env) },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        // Faithful adapter contract: loadAll filters `_`-prefixed internal
        // collections, exactly like real adapters (see sequence.test.ts).
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

const COMP = 'acme'
const SECRET = 'owner secret long enough to be safe'

describe('reserved _manifest collection — predicate', () => {
  it('isManifestReservedCollection("_manifest") is true', () => {
    expect(isManifestReservedCollection(MANIFEST_COLLECTION)).toBe(true)
  })

  it('isManifestReservedCollection("invoices") is false', () => {
    expect(isManifestReservedCollection('invoices')).toBe(false)
  })

  it('isManifestReservedCollection("_schemas") is false (only _manifest is reserved)', () => {
    expect(isManifestReservedCollection('_schemas')).toBe(false)
  })

  it('MANIFEST_RESERVED_COLLECTIONS contains exactly _manifest', () => {
    expect([...MANIFEST_RESERVED_COLLECTIONS]).toEqual([MANIFEST_COLLECTION])
  })
})

describe('reserved _manifest collection — vault.collection() guard', () => {
  it('rejects vault.collection("_manifest") — even for the owner', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET })
    const vault = await db.openVault(COMP)
    expect(() => vault.collection(MANIFEST_COLLECTION)).toThrow(ReservedCollectionNameError)
  })

  it('still allows ordinary data collections', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET })
    const vault = await db.openVault(COMP)
    expect(() => vault.collection('invoices')).not.toThrow()
  })
})

describe('reserved _manifest collection — travels in a pod dump', () => {
  it('a manifest record written directly to the store survives dump() in _internal', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, historyStrategy: withHistory() })
    const vault = await db.openVault(COMP)

    // The manifest writer (Task 2) isn't built yet — write the raw envelope
    // directly to the store the way Task 2's strict-CAS writer eventually
    // will, to exercise dump()'s reserved-set handling in isolation.
    const envelope: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: '{"v":1,"kind":"schema"}',
    }
    await store.put(COMP, MANIFEST_COLLECTION, 'schema', envelope)

    const backupJson = await vault.dump()
    const backup = JSON.parse(backupJson) as { _internal?: Record<string, Record<string, EncryptedEnvelope>> }
    expect(backup._internal?.[MANIFEST_COLLECTION]?.['schema']).toEqual(envelope)
  })
})
