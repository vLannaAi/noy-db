/**
 * `shredAllForRecord` crash-idempotency — the shred journal wiring (#753
 * Task 3 of PR-1, spec §7 §2c + corrections C1/C4/C5/C6/C8/C10).
 *
 * Task 1 (`blob-journal-primitives.test.ts`) proved the primitives in
 * isolation (`casUpdateRefCountStamped`, `releaseRef`'s two-armed resume).
 * Task 2 (`blob-intent.test.ts`) proved the `_blob_intent` marker plumbing.
 * This file proves the WIRED crash matrix — real crash injection through
 * `vault.forget()` / `shredAllForRecord()` / the mutator resume gates,
 * mirroring `blob-journal-primitives.test.ts`'s `gateFirstIndexPut` (#725
 * interleaved-adapter pattern) for concurrency, and a throw-on-Nth-write
 * wrapper for sequential crash injection.
 *
 * THE #753 regression this whole arc exists to close: crash mid-release-loop
 * → naive retry re-decrements an ALREADY-released co-owned hold, destroying
 * another record's live content. See "co-owner regression" below.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import {
  BLOB_INTENT_COLLECTION,
  createIntent,
  sweepBlobIntents,
  type BlobIntent,
} from '../src/with-shape/blobs/blob-intent.js'

const SECRET = 'blob-shred-journal-test-secret'
const bytes = (s: string) => new TextEncoder().encode(s)

// ─── Store ──────────────────────────────────────────────────────────────

/** In-memory store with raw diagnostics — mirrors forget.test.ts's `memory()`. */
function memory(): NoydbStore & {
  raw(v: string, col: string, id: string): EncryptedEnvelope | undefined
  rawList(v: string, col: string): string[]
} {
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
    raw(v, col, id) { return store.get(v)?.get(col)?.get(id) },
    rawList(v, col) { const c = store.get(v)?.get(col); return c ? [...c.keys()] : [] },
    async get(v, col, id) { return store.get(v)?.get(col)?.get(id) ?? null },
    async put(v, col, id, env, ev) {
      const coll = getCollection(v, col)
      const ex = coll.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      coll.set(id, env)
    },
    async delete(v, col, id) { store.get(v)?.get(col)?.delete(id) },
    async list(v, col) { const c = store.get(v)?.get(col); return c ? [...c.keys()] : [] },
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
      const existing = store.get(v)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) vm.set(name, coll)
      store.set(v, vm)
    },
  }
}

/**
 * Simulates a process crash exactly at the Nth `put` matching `match`: that
 * write hangs FOREVER (never resolves, never rejects) — a real crash kills
 * the process mid-write; nothing ever catches it, nothing ever continues.
 * A `try/catch` around the caller (e.g. `consumeShredIntent`'s per-hold
 * resilience, #753 C10) can only catch a THROW, not a write that simply
 * never returns — so this, not a throw, is what faithfully models "crash
 * after k of n releases": releases 1..k-1 already landed for real, release
 * k is frozen mid-flight, and k+1..n never even start. `onReached` fires
 * right before freezing, so the test can wait for the crash point instead
 * of racing it.
 */
function hangOnNthPut(
  store: NoydbStore,
  match: (col: string, id: string) => boolean,
  n: number,
  onReached: () => void,
): NoydbStore {
  let count = 0
  return {
    ...store,
    async put(v, col, id, env, ev) {
      if (match(col, id)) {
        count++
        if (count === n) { onReached(); return new Promise<void>(() => {}) }
      }
      return store.put(v, col, id, env, ev)
    },
  }
}

/** Delete counterpart of {@link hangOnNthPut} — see its doc comment. */
function hangOnNthDelete(
  store: NoydbStore,
  match: (col: string, id: string) => boolean,
  n: number,
  onReached: () => void,
): NoydbStore {
  let count = 0
  return {
    ...store,
    async delete(v, col, id) {
      if (match(col, id)) {
        count++
        if (count === n) { onReached(); return new Promise<void>(() => {}) }
      }
      return store.delete(v, col, id)
    },
  }
}

/** Blocks the FIRST `_blob_index/{targetId}` put on `gate`, calling `onReached` first — mirrors
 *  `blob-journal-primitives.test.ts`'s `gateFirstIndexPut` (#725 interleaved-adapter pattern). */
function gateFirstIndexPut(
  store: NoydbStore,
  targetId: string,
  hooks: { gate: () => Promise<void>; onReached: () => void },
): NoydbStore {
  let armed = true
  return {
    ...store,
    async put(v, c, id, env, ev) {
      if (armed && c === '_blob_index' && id === targetId) {
        armed = false
        hooks.onReached()
        await hooks.gate()
      }
      return store.put(v, c, id, env, ev)
    },
  }
}

interface Invoice { id: string; buyerId: string; amount: number }

const dbOpts = (store: NoydbStore, extra?: Record<string, unknown>) => ({
  store, user: 'alice', secret: SECRET,
  historyStrategy: withHistory(),
  forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
  blobStrategy: withBlobs(),
  ...extra,
})

// ─── The #753 regression: co-owner survives a crash mid-release-loop ─────

describe('shredAllForRecord crash-idempotency — the #753 regression', () => {
  it('crash after k of n releases → resume: co-owner keeps its refCount, sole-owned fully shredded, rows+marker gone', async () => {
    const store = memory()
    const db0 = await createNoydb(dbOpts(store))
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true })

    // R (buyer-1) has two slots: 'shared.pdf' (co-owned with O, an untouched
    // OTHER buyer's record) and 'sole.pdf' (only R references it).
    await invoices0.put('r', { id: 'r', buyerId: 'buyer-1', amount: 10 })
    await invoices0.put('o', { id: 'o', buyerId: 'buyer-2', amount: 20 }) // untouched
    const sharedContent = bytes('shared content — must survive R\'s forget')
    await invoices0.blob('r').put('shared.pdf', sharedContent)
    await invoices0.blob('o').put('shared.pdf', sharedContent) // dedup hit → refCount 2
    await invoices0.blob('r').put('sole.pdf', bytes('sole content — must be shredded'))
    const sharedETag = (await invoices0.blob('r').blobInfo('shared.pdf'))!.eTag
    const soleETag = (await invoices0.blob('r').blobInfo('sole.pdf'))!.eTag
    expect((await invoices0.blob('r').blobInfo('shared.pdf'))!.refCount).toBe(2)
    db0.close()

    // Crash after the FIRST hold's release lands (shared.pdf, inserted
    // first) but before the second's (sole.pdf) — "crash after k of n
    // releases" with n=2, k=1. The 2nd `_blob_index` put (sole.pdf's
    // decrement) hangs forever — never landing, never throwing (a real
    // crash kills the process; nothing catches it and nothing continues).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === '_blob_index', 2, () => reached())
    const dbCrash = await createNoydb(dbOpts(crashing))
    const vaultCrash = await dbCrash.openVault('v')
    void vaultCrash.forget('buyer-1') // fire-and-forget: this promise never settles (simulated crash)
    await reachedPromise

    // Mid-crash state: shared.pdf's release landed (stamped, refCount 1);
    // sole.pdf's never started. The marker is still present (row deletions
    // never ran — consumeShredIntent only deletes on allApplied).
    expect(store.raw('v', '_blob_index', sharedETag)).toBeDefined()
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)
    expect(store.raw('v', '_blob_slots_invoices', 'r')).toBeDefined() // rows NOT deleted yet

    // Resume: a fresh session's forget() retry (the ref is still in the
    // subject index — the crashed call never reached `_removeSubjectRef`).
    const dbResume = await createNoydb(dbOpts(store))
    const vaultResume = await dbResume.openVault('v')
    await expect(vaultResume.forget('buyer-1')).resolves.toBeDefined()

    // THE regression check: the co-owner's hold survived — shared.pdf is
    // STILL fully readable via O (refCount 1, not driven to 0 and
    // crypto-shredded by the retry).
    const invoicesResume = vaultResume.collection<Invoice>('invoices', { perRecordKeys: true })
    expect(await invoicesResume.blob('o').get('shared.pdf')).toEqual(sharedContent)
    expect(store.raw('v', '_blob_index', sharedETag)).toBeDefined()

    // sole.pdf's hold finished releasing on resume — fully shredded.
    expect(store.raw('v', '_blob_index', soleETag)).toBeUndefined()
    for (let i = 0; i < 4; i++) expect(store.raw('v', '_blob_chunks', `${soleETag}_${i}`)).toBeUndefined()

    // R's rows + marker are gone (both the crashed-run's rows and the
    // marker minted for the resumed attempt).
    expect(store.raw('v', '_blob_slots_invoices', 'r')).toBeUndefined()
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)

    dbResume.close()
  })
})

// ─── C1: crash post-decrement, pre-index-delete — completion arm ─────────

describe('C1 completion arm through the wired forget() flow', () => {
  it('crash between the stamped decrement and the index-row delete → resume completes the deletion', async () => {
    const store = memory()
    const db0 = await createNoydb(dbOpts(store))
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true })
    await invoices0.put('r', { id: 'r', buyerId: 'buyer-1', amount: 10 })
    await invoices0.blob('r').put('solo.pdf', bytes('solo content, C1 arm'))
    const eTag = (await invoices0.blob('r').blobInfo('solo.pdf'))!.eTag
    db0.close()

    // Crash exactly between the refCount-0 decrement (a `_blob_index` PUT,
    // which lands for real) and the index-row deletion (a `_blob_index`
    // DELETE, which hangs forever — never lands, never throws).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthDelete(store, (col, id) => col === '_blob_index' && id === eTag, 1, () => reached())
    const dbCrash = await createNoydb(dbOpts(crashing))
    const vaultCrash = await dbCrash.openVault('v')
    void vaultCrash.forget('buyer-1') // fire-and-forget: this promise never settles (simulated crash)
    await reachedPromise

    // Mid-crash: the decrement landed (refCount 0, stamped) but the index
    // row is still physically present.
    const stranded = store.raw('v', '_blob_index', eTag)
    expect(stranded).toBeDefined()

    const dbResume = await createNoydb(dbOpts(store))
    const vaultResume = await dbResume.openVault('v')
    await expect(vaultResume.forget('buyer-1')).resolves.toBeDefined()

    expect(store.raw('v', '_blob_index', eTag)).toBeUndefined()
    expect(store.raw('v', '_blob_chunks', `${eTag}_0`)).toBeUndefined()
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)
    dbResume.close()
  })
})

// ─── New generation, same eTag: re-shred not skipped by an old stamp ─────

describe('new-generation same-eTag re-shred is not skipped (fresh opId)', () => {
  it('a second forget() releasing the SAME eTag under a fresh opId still decrements', async () => {
    const store = memory()
    const db = await createNoydb(dbOpts(store))
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', { perRecordKeys: true })

    await invoices.put('a', { id: 'a', buyerId: 'buyer-a', amount: 1 })
    await invoices.put('b', { id: 'b', buyerId: 'buyer-b', amount: 2 })
    const content = bytes('re-shredded generation content')
    await invoices.blob('a').put('f.pdf', content)
    await invoices.blob('b').put('f.pdf', content) // dedup hit, refCount 2
    const eTag = (await invoices.blob('a').blobInfo('f.pdf'))!.eTag

    // Generation 1: forget buyer-a — releases ONE hold (opId #1), refCount 2→1.
    await vault.forget('buyer-a')
    expect((await invoices.blob('b').blobInfo('f.pdf'))!.refCount).toBe(1)

    // Generation 2: a NEW record 'c' re-attaches the SAME content (dedup
    // hit against the still-live object) → refCount 1→2, then buyer-c
    // forgets it under a FRESH opId (#2, distinct from #1).
    await invoices.put('c', { id: 'c', buyerId: 'buyer-c', amount: 3 })
    await invoices.blob('c').put('f.pdf', content)
    expect((await invoices.blob('b').blobInfo('f.pdf'))!.refCount).toBe(2)

    await vault.forget('buyer-c')

    // Generation 2's release actually applied (not skipped because eTag's
    // ring already carried opId #1) — refCount back down to 1, b intact.
    expect((await invoices.blob('b').blobInfo('f.pdf'))!.refCount).toBe(1)
    expect(await invoices.blob('b').get('f.pdf')).toEqual(content)

    db.close()
  })
})

// ─── C5: forget-entry resume recovers an ELEVATED record's stranded marker ─

describe('C5 — marker minted pre-tombstone recovers an elevated record\'s tier on resume', () => {
  it('the marker\'s captured ownerTier (1) governs shredAllForRecord even when the caller passes a stale tier (0)', async () => {
    // The C5 window in production: `forget()` mints the marker from the
    // LIVE (pre-tombstone) record's tier, then `_writeTombstone` drops
    // `_tier`. A crash-retried `forget()` re-reads the now-tombstoned
    // record and can only pass `live?._tier ?? 0` — WRONG for an elevated
    // record — to `shredAllForRecord`. This isolates exactly that failure
    // mode: mint the marker at tier 1 (as `forget()`'s pre-tombstone step
    // would), then call `shredAllForRecord` with a deliberately stale `0`
    // — the marker's OWN `ownerTier` must win, not the argument.
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoices.putAtTier('r', { id: 'r', buyerId: 'buyer-1', amount: 10 }, 0)
    await invoices.blob('r').put('elevated.pdf', bytes('elevated-tier content'))
    await invoices.elevate('r', 1) // rehomes the blob to the tier-1 DEK
    const eTag = (await (await invoices.blob('r').atTier()).blobInfo('elevated.pdf'))!.eTag

    // forget()'s pre-tombstone step: mint the marker at the LIVE tier (1).
    await invoices.blob('r').mintShredIntent(1)
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)

    // Retry, as if the record were now tombstoned and the caller could only
    // recover `0` — the marker's `ownerTier: 1` must be used instead.
    const result = await invoices.blob('r').shredAllForRecord(0)
    expect(result.shredded).toContain(eTag)

    // The tier-1-keyed BlobObject + its marker are gone — recovered despite
    // the caller's own tier argument being wrong.
    expect(store.raw('v', '_blob_index', eTag)).toBeUndefined()
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)
    db.close()
  })
})

// ─── C4: two concurrent resumers racing the SAME stranded marker ─────────

describe('C4 — two concurrent resumers racing the same stranded marker', () => {
  it('exactly one release applies; both callers complete without throwing', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true })
    await invoices0.put('r', { id: 'r', buyerId: 'x', amount: 1 })
    await invoices0.blob('r').put('solo.pdf', bytes('concurrency race content'))
    const eTag = (await invoices0.blob('r').blobInfo('solo.pdf'))!.eTag
    // Simulate a crashed forget(): mint the marker directly, but never shred.
    await invoices0.blob('r').mintShredIntent(0)
    db0.close()
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)

    let release!: () => void
    const gatePromise = new Promise<void>((r) => { release = r })
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const gated = gateFirstIndexPut(store, eTag, { gate: () => gatePromise, onReached: () => reached() })

    const db = await createNoydb({ store: gated, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', { perRecordKeys: true })

    // Two independent writes on the SAME record each trigger the
    // resume-gate (`resolvePendingIntent`) at entry — racing the same
    // marker's single stranded hold.
    const p1 = invoices.blob('r').put('other-1.pdf', bytes('a')) // gated: blocks mid-resume
    await reachedPromise
    const p2 = invoices.blob('r').put('other-2.pdf', bytes('b')) // races in, resolves cleanly
    await p2
    release()
    await expect(p1).resolves.toBeUndefined() // p1's own resume attempt tolerates losing the race

    // Exactly one release applied — the sole-owned object is gone.
    expect(store.raw('v', '_blob_index', eTag)).toBeUndefined()
    // Both callers' own writes succeeded regardless of who won the resume race.
    expect(await invoices.blob('r').get('other-1.pdf')).toEqual(bytes('a'))
    expect(await invoices.blob('r').get('other-2.pdf')).toEqual(bytes('b'))
    // The marker is gone (consumed by whichever resumer completed first).
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)

    db.close()
  })
})

// ─── A pending 'rehome' marker is resumed, not refused (#746 PR-2) ───────

describe('a pending rehome marker is resumed by the next write, not refused (#746 spec §7 C6)', () => {
  it('put() resumes a stranded elevate() rehome to completion before its own write proceeds', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoices0.put('r', { id: 'r', buyerId: 'x', amount: 1 })
    await invoices0.blob('r').put('a.pdf', bytes('elevated content'))
    db0.close()

    // Crash `elevate()` exactly at the rehome marker's OWN first write
    // (`_blob_slots_invoices`'s slot-CAS, inside `runRehomeSteps`) — the
    // record's `_tier` already landed at 1 (elevate() writes the record
    // BEFORE calling syncBlobs/syncTierMove), but the blob side never moved.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === '_blob_slots_invoices', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultCrash = await dbCrash.openVault('v')
    const invoicesCrash = vaultCrash.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    void invoicesCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)

    // Fresh session: an ORDINARY put() must resume the stranded rehome
    // FIRST (not throw), then proceed with its own write on the now-clean
    // record.
    const dbResume = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultResume = await dbResume.openVault('v')
    const invoicesResume = vaultResume.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoicesResume.blob('r').put('b.pdf', bytes('new content'))

    // The marker is gone and the elevated blob is readable at tier 1.
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)
    const atTier = await invoicesResume.blob('r').atTier()
    expect(await atTier.get('a.pdf')).toEqual(bytes('elevated content'))
    expect(await atTier.get('b.pdf')).toEqual(bytes('new content'))

    dbResume.close()
  })

  it('shredAllForRecord() resumes a pending rehome FIRST, then shreds (#746 spec §7 Q1)', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoices0.put('r', { id: 'r', buyerId: 'x', amount: 1 })
    await invoices0.blob('r').put('a.pdf', bytes('elevated content'))
    db0.close()

    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === '_blob_slots_invoices', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultCrash = await dbCrash.openVault('v')
    const invoicesCrash = vaultCrash.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    void invoicesCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Q1: a half-done rehome can leave a row-unreferenced destination object
    // shred's row-derived holds could never see — resume-then-shred (not
    // supersede) is what keeps it reachable. `shredAllForRecord()` must
    // resume the rehome to completion (blob physically at tier 1, marker
    // gone) BEFORE minting/consuming its own shred marker.
    const dbResume = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultResume = await dbResume.openVault('v')
    const invoicesResume = vaultResume.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    const result = await invoicesResume.blob('r').shredAllForRecord(1) // caller passes the record's live (post-elevate) tier
    expect(result.shredded).toHaveLength(1)
    expect(result.residue).toEqual([])

    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)
    expect(store.rawList('v', '_blob_slots_invoices')).toHaveLength(0)

    dbResume.close()
  })
})

// ─── #746 review Critical 1: a rehome-resume failure must PROPAGATE ──────

describe('#746 review Critical 1 — a rehome-resume failure propagates, never degrades to unmarkedShred', () => {
  it('shredAllForRecord() discovers a pending rehome marker whose resume release THROWS → the error propagates, the marker survives, rows are not clobbered by an unmarked shred', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoices0.put('r', { id: 'r', buyerId: 'x', amount: 1 })
    await invoices0.blob('r').put('a.pdf', bytes('elevated content'))
    const oldETag = (await invoices0.blob('r').blobInfo('a.pdf'))!.eTag
    db0.close()

    // Crash `elevate()` exactly after the slot CAS lands (the slot now
    // points at the NEW eTag; the `pendingRelease` breadcrumb durably
    // records the old one — #746 review carried finding (b)) but BEFORE
    // the old object's release even starts: hang on the FIRST `_blob_index`
    // put targeting `oldETag` itself (mirrors
    // blob-rehome-journal.test.ts's dedicated finding-(b) crash point).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing: NoydbStore = {
      ...store,
      async put(v, col, id, env, ev) {
        if (col === '_blob_index' && id === oldETag) { reached(); return new Promise<void>(() => {}) }
        return store.put(v, col, id, env, ev)
      },
    }
    const dbCrash = await createNoydb({ store: crashing, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultCrash = await dbCrash.openVault('v')
    const invoicesCrash = vaultCrash.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    void invoicesCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)
    expect(store.raw('v', '_blob_index', oldETag)).toBeDefined() // untouched — release never even started

    // Resume: a fresh session where the SAME write (the old object's
    // release CAS) THROWS instead of hanging — a genuine, non-crash write
    // failure (e.g. a transient store error), not a process crash.
    // `shredAllForRecord()` discovers the pending rehome marker and must
    // resume it FIRST (Q1); that resume's own release now fails for real.
    const throwing: NoydbStore = {
      ...store,
      async put(v, col, id, env, ev) {
        if (col === '_blob_index' && id === oldETag) throw new Error('simulated release failure')
        return store.put(v, col, id, env, ev)
      },
    }
    const dbResume = await createNoydb({ store: throwing, user: 'a', secret: SECRET, blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultResume = await dbResume.openVault('v')
    const invoicesResume = vaultResume.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })

    // THE regression check: the failure PROPAGATES out of
    // `shredAllForRecord()` — it must reject, never silently return a
    // degraded (unmarked-shred) result over an ambiguous half-moved record.
    await expect(invoicesResume.blob('r').shredAllForRecord(1)).rejects.toThrow('simulated release failure')

    // The rehome marker SURVIVES (never `deleteIntent`d) — resumable
    // later, not silently abandoned.
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)

    // Rows are NOT clobbered by an unmarked shred: the slot map row still
    // exists (`unmarkedShred` would have unconditionally deleted it), and
    // the old object is untouched (its release genuinely never landed).
    expect(store.rawList('v', '_blob_slots_invoices')).toHaveLength(1)
    expect(store.raw('v', '_blob_index', oldETag)).toBeDefined()

    dbResume.close()
  })
})

// ─── Sweep isolation: one corrupt marker doesn't block a healthy sibling ──

describe('sweepBlobIntents isolation (#753 Task 3 item 5, carried Task 2 finding)', () => {
  it('a marker whose resume throws does not block a healthy sibling from resuming', async () => {
    const store = memory()
    const dek = await generateDEK()
    const getDEK = async () => dek

    const good: BlobIntent = { op: 'shred', opId: 'op-good', ownerTier: 0, holds: [] }
    const bad: BlobIntent = { op: 'shred', opId: 'op-bad', ownerTier: 0, holds: [] }
    await createIntent(store, 'v', 'invoices', 'good-rec', getDEK, good)
    await createIntent(store, 'v', 'invoices', 'bad-rec', getDEK, bad)

    const resumed: string[] = []
    const errors: Array<{ collection: string; recordId: string }> = []
    await sweepBlobIntents(
      store, 'v', getDEK,
      async (collection, recordId) => {
        if (recordId === 'bad-rec') throw new Error('resume genuinely fails for bad-rec')
        resumed.push(recordId)
      },
      (collection, recordId) => { errors.push({ collection, recordId }) },
    )

    expect(resumed).toEqual(['good-rec']) // the healthy sibling still resumed
    expect(errors).toEqual([{ collection: 'invoices', recordId: 'bad-rec' }]) // surfaced, not swallowed
  })
})

// ─── Whole-branch review: intent-mint failure must never block erasure ───

describe('#753 whole-branch review — intent-mint failure degrades to best-effort shred + residue', () => {
  it('every `_blob_intent` put throwing does not abort forget(): the record BODY is still crypto-shredded, and the blob-shred degradation surfaces as residue', async () => {
    const store = memory()
    const db0 = await createNoydb(dbOpts(store))
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true })
    await invoices0.put('r', { id: 'r', buyerId: 'buyer-1', amount: 10 })
    await invoices0.blob('r').put('doc.pdf', bytes('erase me too'))
    db0.close()

    // Models a transient store failure in `createIntent` (or an upstream
    // `getDEK` failure) — every `_blob_intent` write throws. This hits BOTH
    // mint call sites: `vault.forget()`'s own pre-tombstone
    // `mintShredIntent` (vault.ts) AND `shredAllForRecord`'s no-marker
    // entry-mint fallback (blob-set.ts) when it retries with no marker
    // present.
    const throwing: NoydbStore = {
      ...store,
      async put(v, col, id, env, ev) {
        if (col === BLOB_INTENT_COLLECTION) throw new Error('simulated _blob_intent put failure')
        return store.put(v, col, id, env, ev)
      },
    }
    const db = await createNoydb(dbOpts(throwing))
    const vault = await db.openVault('v')

    // Priority-inversion check: pre-fix, this throw propagated OUT of
    // `mintShredIntent` (vault.ts, ungated unlike every sibling purge in the
    // loop) and aborted forget() before `_writeTombstone` ran — the body
    // survived. Post-fix, forget() completes.
    const result = await vault.forget('buyer-1')

    // The record BODY is crypto-shredded — the primary erasure the mint
    // failure must never hold hostage.
    expect(result.recordsShredded).toBe(1)
    const invoices = vault.collection<Invoice>('invoices', { perRecordKeys: true })
    expect(await invoices.get('r')).toBeNull()
    expect(store.raw('v', 'invoices', 'r')!._data).toBe('')

    // The blob-journal degradation is surfaced as residue, never silently
    // dropped — `blobResidueCollections` is the natural existing channel.
    expect(result.blobResidueCollections).toContain('invoices')

    db.close()
  })
})

// ─── THE Q1 KEYSTONE: a row-unreferenced destination object survives ONLY
// because resume-then-shred (not replace) reaches it ──────────────────────

describe('Q1 keystone — resume-then-shred reaches a row-unreferenced rehome orphan (#746/#753 spec Q1)', () => {
  it('rehome crashes leaving an orphan destination object (refCount>=1, no slot/version row points at it); vault.forget() resumes the rehome THEN shreds — the orphan is fully erased, proving a row-derived (non-superseding) shred would have stranded it', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, user: 'a', secret: SECRET, historyStrategy: withHistory(), forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }), blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vault0 = await db0.openVault('v')
    const invoices0 = vault0.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    await invoices0.put('r', { id: 'r', buyerId: 'buyer-1', amount: 10 })
    await invoices0.blob('r').put('a.pdf', bytes('orphan-bound content'))
    const oldETag = (await invoices0.blob('r').blobInfo('a.pdf'))!.eTag
    db0.close()

    // Crash `elevate()` exactly at the FIRST `_blob_slots_invoices` put —
    // `putUnderDEK`'s sequencing is: (1) `writeBlobContent` lands the
    // destination create/`+1` at tier 1 (a `_blob_index` write) FIRST, THEN
    // (2) the slot CAS (`_blob_slots_invoices`) points the slot at it. This
    // hangs exactly between (1) and (2): the fresh tier-1 `BlobObject`
    // physically exists — refCount >= 1, fully decryptable under the tier-1
    // DEK — but NO slot or version row has been re-pointed at it yet. Spec
    // Q1's exact orphan window.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === '_blob_slots_invoices', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, user: 'a', secret: SECRET, historyStrategy: withHistory(), forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }), blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultCrash = await dbCrash.openVault('v')
    const invoicesCrash = vaultCrash.collection<Invoice>('invoices', { perRecordKeys: true, tiers: [0, 1] })
    void invoicesCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // ── Orphan precondition ──────────────────────────────────────────────
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(true)
    const indexKeysMidCrash = store.rawList('v', '_blob_index')
    expect(indexKeysMidCrash).toHaveLength(2) // untouched old (tier-0) object + the new orphan (tier-1)
    const orphanETag = indexKeysMidCrash.find((k) => k !== oldETag)!

    // The orphan is a REAL, decryptable BlobObject at tier 1 — not a stray
    // write.
    const orphanReader = invoicesCrash.blob('r') as unknown as {
      loadBlobObject(eTag: string, tier?: number): Promise<{ blob: { refCount: number } } | null>
      loadSlots(tier?: number): Promise<{ slots: Record<string, { eTag: string }> }>
    }
    const orphanLoaded = await orphanReader.loadBlobObject(orphanETag, 1)
    expect(orphanLoaded).not.toBeNull()
    expect(orphanLoaded!.blob.refCount).toBeGreaterThanOrEqual(1)

    // THE CONTRAST: the slot map is still physically at tier 0 (the slot
    // CAS never landed) and points ONLY at `oldETag`. A row-derived hold
    // collection — the ONLY thing a plain, non-superseding shred has to go
    // on (`collectShredHolds`: slot map + published versions, nothing
    // else) — can never discover `orphanETag`. A shred that REPLACED the
    // pending rehome marker instead of resuming it first would release
    // `oldETag`, delete the slot map, and leave `orphanETag`'s fully
    // decryptable `_blob_index` row + chunks behind forever: live,
    // erasable content silently surviving `forget()`.
    const { slots: midCrashSlots } = await orphanReader.loadSlots(0)
    expect(midCrashSlots['a.pdf']!.eTag).toBe(oldETag) // NOT orphanETag — proves the row-derived view is blind to it

    // ── Resume-then-shred: vault.forget() on a fresh session ────────────
    const dbResume = await createNoydb({ store, user: 'a', secret: SECRET, historyStrategy: withHistory(), forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }), blobStrategy: withBlobs(), tiersStrategy: withTiers() })
    const vaultResume = await dbResume.openVault('v')
    await expect(vaultResume.forget('buyer-1')).resolves.toBeDefined()

    // THE regression check: the orphan is FULLY erased — index row AND
    // chunks gone — proving resume-then-shred reached it (Q1's raison
    // d'être), not just the object the live slot map could see.
    expect(store.raw('v', '_blob_index', orphanETag)).toBeUndefined()
    expect(store.raw('v', '_blob_chunks', `${orphanETag}_0`)).toBeUndefined()

    // The old (tier-0) object is also gone — released as part of the
    // resumed rehome's own move, well before shred ever mints its marker.
    expect(store.raw('v', '_blob_index', oldETag)).toBeUndefined()

    // No marker, no rows survive.
    expect(store.rawList('v', BLOB_INTENT_COLLECTION).some((k) => k.startsWith('invoices::r'))).toBe(false)
    expect(store.rawList('v', '_blob_slots_invoices')).toHaveLength(0)

    dbResume.close()
  })
})
