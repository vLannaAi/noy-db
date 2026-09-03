/**
 * #835 — verification of the suspected CRDT write-tail divergences.
 *
 * `_putInternal`'s CRDT branch re-implements the tail of the normal write
 * path instead of sharing it, and a code review flagged three helpers the
 * CRDT branch never calls: `_ensureClassifiedMarker`,
 * `uniqueConstraints.check/upsert`, and `_toCacheableRecord`.
 *
 * These tests establish which of the three is actually reachable. Two are
 * not — the config layer already refuses the combination that would need
 * them — and this file pins that reasoning so the next reader doesn't have
 * to re-derive it (or "fix" a non-bug).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withCrdt } from '../src/with-commit/crdt/index.js'
import { withClassified } from '../src/via/classified/index.js'
import { classified } from '../src/via/classified/presets.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'

interface Doc extends Record<string, unknown> { title?: string; email?: string }

async function crdtDb(extra: Record<string, unknown> = {}) {
  return createNoydb({
    store: memoryStore(), user: 'alice', encrypt: false,
    crdtStrategy: withCrdt(), ...extra,
  })
}

describe('#835 — CRDT write-tail divergences: which are reachable?', () => {
  /**
   * NOT reachable. Guard R2 (`via/classified/guards.ts`) refuses
   * digest-only/recoverable classified fields on a CRDT collection, with
   * exactly this reasoning: merge paths bypass write enforcement, and "the
   * CRDT put branch persists via encryptJsonString with no vdig backstop".
   * So `vdigFields` can never be non-null on a CRDT collection, and
   * `_ensureClassifiedMarker` early-returns on `vdigFields === null`.
   */
  it('classified digest-only + crdt is REFUSED at config time (so the missing marker is unreachable)', async () => {
    const db = await crdtDb({ classifiedStrategy: withClassified() })
    const vault = await db.openVault('acme')
    expect(() =>
      vault.collection<Doc>('docs', {
        crdt: 'lww-map',
        // `password` is a digest-only preset — the storage class R2 refuses.
        classifiedFields: { title: classified.password() },
      }),
    ).toThrowError(/crdt mode|R2/)
  })

  /**
   * Also NOT reachable, for a second reason: `toCacheRecord` only does work
   * when the envelope carries `_sealed` slots, and the CRDT branch writes
   * through `encryptJsonString`, which never produces them. With no vdig
   * fields possible (above) and no `_sealed` present, `_toCacheableRecord`
   * would be an identity function — caching `resolvedRecord` directly is
   * equivalent, not a leak.
   */
  it('a CRDT envelope carries no _sealed slots (so the skipped cache-normalisation is a no-op)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'alice', encrypt: false, crdtStrategy: withCrdt(),
    })
    const vault = await db.openVault('acme')
    const docs = vault.collection<Doc>('docs', { crdt: 'lww-map' })
    await docs.put('d1', { title: 'hello' })
    const env = await store.get('acme', 'docs', 'd1')
    expect(env).not.toBeNull()
    expect(env?._sealed).toBeUndefined()
  })

  /**
   * SUPERSEDED by #1358, and the reason is worth keeping.
   *
   * This case used to assert that a unique index on a CRDT collection was
   * REFUSED at config time, which made the CRDT branch's missing
   * `uniqueConstraints.check` unreachable. #1358 removed that refusal — but
   * NOT by adding the missing check: a replica cannot refuse a value another
   * offline replica may already hold, so `check()` is a deliberate no-op in
   * CRDT (`detect`) mode. What closes the divergence is `upsert()`, which the
   * CRDT write tail DOES call, reporting the collision on `unique:violation`.
   *
   * So the invariant this file cares about still holds — the CRDT branch
   * skips nothing that would have refused a write — and it now holds for a
   * stated reason instead of by unreachability. The behaviour itself is
   * asserted in `unique-constraint-modes.test.ts`.
   */
  it('unique index + crdt is ACCEPTED, and the write tail reports rather than refuses', async () => {
    const db = await crdtDb({ indexingStrategy: withIndexing() })
    const vault = await db.openVault('acme')
    const violations: Error[] = []
    db.on('unique:violation', e => { violations.push(e.error) })
    const docs = vault.collection<Doc & { email?: string }>('docs', {
      crdt: 'lww-map',
      indexes: [{ fields: ['email'], unique: true }],
    })
    await docs.put('d1', { title: 'a', email: 'x@y.z' })
    await expect(docs.put('d2', { title: 'b', email: 'x@y.z' })).resolves.toBeUndefined()
    expect(violations).toHaveLength(1)
  })

  /**
   * The one REAL hole this investigation found — now closed (#850).
   *
   * `sensitive` promises each field its own `_sealed` slot under an
   * HKDF-derived per-field key. The CRDT branch never seals, so the fields
   * were silently stored in the ordinary encrypted body: no per-field key,
   * no slot, no error. Verified empirically before the fix — a non-CRDT
   * collection produced `_sealed: { secret: … }` while the CRDT one produced
   * nothing. Refused at config time now, matching the embeddings / unique /
   * R2 precedents.
   */
  it('sensitive + crdt is REFUSED at config time (#850 — it used to be silently ignored)', async () => {
    const db = await crdtDb()
    const vault = await db.openVault('acme')
    expect(() =>
      vault.collection<Doc>('docs-sealed', { crdt: 'lww-map', sensitive: ['title'] }),
    ).toThrowError(/sensitive .* not supported on CRDT|bypasses per-field sealing/)
  })

  it('sensitive still seals normally on a NON-crdt collection (the control)', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'alice', secret: 'pw-835-control' })
    const vault = await db.openVault('acme')
    const plain = vault.collection<Doc>('plain', { sensitive: ['title'] })
    await plain.put('p1', { title: 'secret-value' })
    const env = await store.get('acme', 'plain', 'p1')
    expect(env?._sealed).toBeDefined()
    expect(Object.keys(env?._sealed ?? {})).toContain('title')
  })
})
