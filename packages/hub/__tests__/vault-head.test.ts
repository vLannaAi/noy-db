/**
 * The vault head's storage layer (#1044).
 *
 * The head is what catches **omission** — the one attack #1041 and #1042 cannot
 * see. An authentic old envelope is indistinguishable from an authentic current
 * one without external knowledge of what should be there; the head is that
 * knowledge.
 *
 * These exercise the strategy directly against a store and a DEK, so each
 * property is asserted in isolation from the write path that will call it.
 */
import { describe, it, expect } from 'vitest'
import { memoryStore } from '../src/index.js'
import { generateDEK, openEnvelopeJson, recordAadFor, decrypt, writeEnvelopeBody, buildRecordEnvelope, type EnclaveKey } from '../src/kernel/enclave/index.js'
import { withVaultHead, verifyVaultHead, VAULT_HEAD_COLLECTION } from '../src/with-commit/vault-head/index.js'
import { bucketIndex } from '../src/with-commit/vault-head/head.js'

const VAULT = 'acme'
const COLL = 'docs'

async function fixture(buckets?: number) {
  const store = memoryStore()
  const dek = await generateDEK()
  const getDEK = async (_c: string): Promise<EnclaveKey> => dek
  const head = withVaultHead(buckets === undefined ? {} : { buckets })
  return { store, dek, getDEK, head }
}

describe('#1044 — vault head', () => {
  it('1. records and returns a record’s expected version', async () => {
    const { store, getDEK, head } = await fixture()
    await head.note(store, VAULT, getDEK, { collection: COLL, id: 'd1', version: 3 })
    expect(await head.expected(store, VAULT, getDEK, COLL, 'd1')).toBe(3)
  })

  it('2. an unknown record is `null`, distinct from version 0', async () => {
    // "Never seen" and "seen at version 0" are different claims: the first
    // means the sweep has nothing to compare, the second is a real expectation.
    const { store, getDEK, head } = await fixture()
    expect(await head.expected(store, VAULT, getDEK, COLL, 'nope')).toBeNull()
    await head.note(store, VAULT, getDEK, { collection: COLL, id: 'z', version: 0 })
    expect(await head.expected(store, VAULT, getDEK, COLL, 'z')).toBe(0)
  })

  it('3. MONOTONIC: a note that would lower a version is ignored', async () => {
    // The head must not be usable to launder a rollback. If a stale retry — or
    // a replayed write — could walk an entry backwards, the sweep would stop
    // expecting the newer version and the omission it exists to catch becomes
    // invisible.
    const { store, getDEK, head } = await fixture()
    await head.note(store, VAULT, getDEK, { collection: COLL, id: 'd1', version: 7 })
    await head.note(store, VAULT, getDEK, { collection: COLL, id: 'd1', version: 2 })
    expect(await head.expected(store, VAULT, getDEK, COLL, 'd1')).toBe(7)
  })

  it('4. `knownIn` returns every record of a collection, across all buckets', async () => {
    // A record's bucket is a function of its id, so one collection's entries
    // are spread over the whole bucket set. A sweep that read one bucket would
    // silently report a fraction of the vault as complete.
    const { store, getDEK, head } = await fixture(8)
    for (let i = 0; i < 40; i++) {
      await head.note(store, VAULT, getDEK, { collection: COLL, id: `d${i}`, version: i })
    }
    const known = await head.knownIn(store, VAULT, getDEK, COLL)
    expect(known.size).toBe(40)
    expect(known.get('d17')).toBe(17)
  })

  it('5. collections do not bleed into one another', async () => {
    const { store, getDEK, head } = await fixture(4)
    await head.note(store, VAULT, getDEK, { collection: 'a', id: 'x', version: 1 })
    await head.note(store, VAULT, getDEK, { collection: 'b', id: 'x', version: 2 })
    expect((await head.knownIn(store, VAULT, getDEK, 'a')).size).toBe(1)
    expect(await head.expected(store, VAULT, getDEK, 'b', 'x')).toBe(2)
  })

  it('6. buckets are ENCRYPTED and identity-bound — the store learns nothing and cannot move them', async () => {
    const { store, dek, getDEK, head } = await fixture(4)
    await head.note(store, VAULT, getDEK, { collection: COLL, id: 'secret-invoice-id', version: 1 })

    const [bucket] = await store.list(VAULT, VAULT_HEAD_COLLECTION)
    const env = (await store.get(VAULT, VAULT_HEAD_COLLECTION, bucket!))!

    // No record id in the clear.
    expect(JSON.stringify(env)).not.toContain('secret-invoice-id')
    // Opens at its own address…
    await expect(openEnvelopeJson({ collection: VAULT_HEAD_COLLECTION, id: bucket! }, env, dek)).resolves.toContain('secret-invoice-id')
    // …and NOT at another, so a store cannot serve bucket 2's bytes as bucket 1.
    await expect(
      decrypt(env._iv, env._data, dek, recordAadFor({ collection: VAULT_HEAD_COLLECTION, id: 'docs::99' }, env)),
    ).rejects.toThrow()
  })

  it('7. bucketing is deterministic and spreads', async () => {
    // Deterministic, or a record's expectation could not be found again.
    expect(bucketIndex(COLL, 'd1', 256)).toBe(bucketIndex(COLL, 'd1', 256))
    // And spread, or "bucketed" would be a per-vault manifest wearing a hat.
    const hit = new Set<number>()
    for (let i = 0; i < 500; i++) hit.add(bucketIndex(COLL, `d${i}`, 16))
    expect(hit.size).toBe(16)
  })

  it('8. the WRITE stays small as the vault grows — the reason for bucketing', async () => {
    // ADR 0003 left head granularity open and asked for it to be sized. This
    // pins the answer: adding the 500th record rewrites one bucket, not the
    // whole manifest. A per-vault manifest at the documented 50K ceiling is
    // 1.1 MiB per commit; this is the measurement that rejected it.
    const { store, dek, getDEK, head } = await fixture(64)
    for (let i = 0; i < 500; i++) {
      await head.note(store, VAULT, getDEK, { collection: COLL, id: `record-${i}`, version: 1 })
    }
    const sizes: number[] = []
    for (const b of await store.list(VAULT, VAULT_HEAD_COLLECTION)) {
      const env = (await store.get(VAULT, VAULT_HEAD_COLLECTION, b))!
      sizes.push(await openEnvelopeJson({ collection: VAULT_HEAD_COLLECTION, id: b }, env, dek).then(j => j.length))
    }
    const largest = Math.max(...sizes)
    const wholeVault = sizes.reduce((a, b) => a + b, 0)
    // Each write touches ONE bucket, so the cost is the largest bucket — a
    // small fraction of the manifest, and it stays that way as the vault grows.
    expect(largest).toBeLessThan(wholeVault / 8)
  })
})

describe('#1044 — the sweep detects what per-envelope authentication cannot', () => {
  it('9. END TO END: a withheld record is detected, and an untouched vault is clean', async () => {
    const { createNoydb } = await import('../src/kernel/noydb.js')
    const { verifyVaultHead } = await import('../src/with-commit/vault-head/index.js')
    const store = memoryStore()
    const head = withVaultHead()
    const db = await createNoydb({ vaultHeadStrategy: head, store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ n: number }>(COLL)
    await docs.put('d1', { n: 1 })
    await docs.put('d2', { n: 2 })

    const { adapter, getDEK } = vault._introspectState()

    // Control first: an untouched vault must sweep clean, or every assertion
    // below is satisfied by a detector that simply always complains.
    const before = await verifyVaultHead(head, adapter, VAULT, getDEK, COLL)
    expect(before.checked).toBe(2)
    // `memoryStore` advertises casAtomic, so a met sweep is fully 'verified'.
    expect(before.verdict).toBe('verified')
    expect(before.because).toEqual([])

    // The store withholds d1 — serving nothing. Every envelope it DOES serve is
    // perfectly authentic, which is exactly why #1041/#1042 see nothing wrong.
    await adapter.delete(VAULT, COLL, 'd1')

    const after = await verifyVaultHead(head, adapter, VAULT, getDEK, COLL)
    expect(after.verdict).toBe('tampered')
    expect(after.discrepancies).toEqual([
      { collection: COLL, id: 'd1', expected: 1, actual: null, kind: 'withheld' },
    ])
  })

  it('10. a ROLLED-BACK record is detected — an authentic older version served in place of the current one', async () => {
    const { createNoydb } = await import('../src/kernel/noydb.js')
    const { verifyVaultHead } = await import('../src/with-commit/vault-head/index.js')
    const store = memoryStore()
    const head = withVaultHead()
    const db = await createNoydb({ vaultHeadStrategy: head, store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ n: number }>(COLL)
    await docs.put('d1', { n: 1 })
    const v1 = (await store.get(VAULT, COLL, 'd1'))!
    await docs.put('d1', { n: 2 })

    const { adapter, getDEK } = vault._introspectState()
    // Re-serve the genuine v1. It authenticates perfectly — it IS a real record
    // this client wrote — so nothing per-envelope can object.
    await adapter.put(VAULT, COLL, 'd1', v1)

    const result = await verifyVaultHead(head, adapter, VAULT, getDEK, COLL)
    expect(result.discrepancies).toEqual([
      { collection: COLL, id: 'd1', expected: 2, actual: 1, kind: 'rolled-back' },
    ])
  })

  it('11. a record the head never saw is NOT reported — the claim is one-directional', async () => {
    // The head can be switched on for an existing vault; every pre-existing
    // record would otherwise read as an anomaly and the report would be noise.
    const { createNoydb } = await import('../src/kernel/noydb.js')
    const { verifyVaultHead } = await import('../src/with-commit/vault-head/index.js')
    const store = memoryStore()
    const head = withVaultHead()
    const db = await createNoydb({ vaultHeadStrategy: head, store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault(VAULT)
    await vault.collection<{ n: number }>(COLL).put('known', { n: 1 })
    const { adapter, getDEK } = vault._introspectState()

    // Something the head has no expectation for.
    await adapter.put(VAULT, COLL, 'stranger', (await adapter.get(VAULT, COLL, 'known'))!)

    const result = await verifyVaultHead(head, adapter, VAULT, getDEK, COLL)
    expect(result.verdict).toBe('verified')
    expect(result.discrepancies).toEqual([])
  })
})

describe('#1101 — the verdict is three-way, and "unverifiable" is not "clean"', () => {
  /** A store that honestly declares it cannot serialize a compare-and-swap. */
  function withoutCas(base: ReturnType<typeof memoryStore>): ReturnType<typeof memoryStore> {
    const caps = base.capabilities!
    return { ...base, capabilities: { ...caps, casAtomic: false } }
  }

  it('12. a vault the head knows NOTHING about is `unverifiable`, never `verified`', async () => {
    // The shape of this subsystem's own first bug: a head that recorded nothing
    // swept perfectly clean, because "no expectations" and "all expectations
    // met" rendered identically. They must not.
    const { store, getDEK, head } = await fixture()
    const result = await verifyVaultHead(head, store, VAULT, getDEK, COLL)
    expect(result.checked).toBe(0)
    expect(result.verdict).toBe('unverifiable')
    expect(result.because).toContain('no-expectations')
  })

  it('13. a store that cannot CAS is `unverifiable` even when every expectation is MET', async () => {
    // Capability honesty is an INTEGRITY concern here, not a lost-update one: a
    // store that declines CAS can silently drop a head entry, and a dropped
    // entry is a record the sweep stops expecting — a false clean. So a fully
    // met sweep against such a store is still not a clean bill of health.
    const { store, dek, getDEK, head } = await fixture()
    const noCas = withoutCas(store)

    await head.note(noCas, VAULT, getDEK, { collection: COLL, id: 'd1', version: 1 })
    // The sweep reads only `_v`, so a minimal envelope satisfies the expectation.
    const ident = { collection: COLL, id: 'd1', version: 1 }
    const body = await writeEnvelopeBody(ident, '{}', dek)
    await noCas.put(VAULT, COLL, 'd1', buildRecordEnvelope(ident, { iv: body._iv, data: body._data }))

    const result = await verifyVaultHead(head, noCas, VAULT, getDEK, COLL)
    expect(result.discrepancies).toEqual([]) // nothing is actually wrong…
    expect(result.because).toContain('store-cannot-cas')
    expect(result.verdict).toBe('unverifiable') // …but it cannot be called verified
  })

  it('14. a real discrepancy OUTRANKS any unverifiable reason', async () => {
    // Positive evidence wins: a withheld record found by a head that may ALSO be
    // missing other entries is still a withheld record, and reporting it as
    // merely "unverifiable" would bury the one thing worth acting on.
    const { store, getDEK, head } = await fixture()
    const noCas = withoutCas(store)

    await head.note(noCas, VAULT, getDEK, { collection: COLL, id: 'ghost', version: 4 })

    const result = await verifyVaultHead(head, noCas, VAULT, getDEK, COLL)
    expect(result.because).toContain('store-cannot-cas')
    expect(result.verdict).toBe('tampered')
    expect(result.discrepancies[0]).toMatchObject({ id: 'ghost', kind: 'withheld' })
  })
})
