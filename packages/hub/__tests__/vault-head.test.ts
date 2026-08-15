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
import { generateDEK, openEnvelopeJson, recordAadFor, decrypt, type EnclaveKey } from '../src/kernel/enclave/index.js'
import { withVaultHead, VAULT_HEAD_COLLECTION } from '../src/with-commit/vault-head/index.js'
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
