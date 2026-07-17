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
import { ConflictError, BlobRehomeResumeNotImplementedError } from '../src/kernel/errors.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import {
  BLOB_INTENT_COLLECTION,
  createIntent,
  sweepBlobIntents,
  type BlobIntent,
} from '../src/with-shape/blobs/blob-intent.js'

const SECRET = 'blob-shred-journal-test-passphrase'
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

// ─── A pending 'rehome' marker → clear PR-2 seam error ───────────────────

describe('a pending rehome marker refuses cleanly (PR-1/PR-2 seam)', () => {
  it('put() and shredAllForRecord() both throw BlobRehomeResumeNotImplementedError', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', { perRecordKeys: true })
    await invoices.put('r', { id: 'r', buyerId: 'x', amount: 1 })

    const rehome: BlobIntent = { op: 'rehome', opId: 'rehome-op', fromTier: 0, toTier: 1, policy: 'isolate' }
    const getDEK = (vault as unknown as { getDEK: (c: string) => Promise<import('../src/kernel/enclave/index.js').EnclaveKey> }).getDEK
    await createIntent(store, 'v', 'invoices', 'r', getDEK, rehome)

    await expect(invoices.blob('r').put('x.pdf', bytes('x'))).rejects.toBeInstanceOf(BlobRehomeResumeNotImplementedError)
    await expect(invoices.blob('r').shredAllForRecord()).rejects.toBeInstanceOf(BlobRehomeResumeNotImplementedError)

    db.close()
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
