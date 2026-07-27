/**
 * #753 blob durability journal — PR-1 primitives (spec §7):
 *  - `loadBlobObject`'s two-tier loader mode (generalizes #747's t>0→flat
 *    fallback to an explicit try-`tier`-then-`alsoTryTier` pair).
 *  - `BlobObject.lastOps` — the bounded (K=8) op-stamp ring, appended in the
 *    same CAS write as a refCount change (C2).
 *  - `casUpdateRefCountStamped` — the stamp-aware CAS whose membership check
 *    lives INSIDE the retry loop, a true test-and-set (C4).
 *  - `releaseRef`'s stamped two-armed resume rule (C1).
 *
 * These are internal (private) `BlobSet` methods — no public entry point
 * threads a stamp yet (that's PR-1's later steps / PR-2). Tests reach them
 * via a typed cast on the `BlobSet` handle returned by `collection.blob(id)`,
 * the same pattern used elsewhere in this suite for other private internals
 * (e.g. `history-at-rest.test.ts`'s `(vault as unknown as {...}).getDEK`).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, BlobObject } from '../src/kernel/types.js'
import { ConflictError, TamperedError } from '../src/index.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'

// ─── Store ──────────────────────────────────────────────────────────────

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

/** Wrap a store so the FIRST `put` to `_blob_index/{targetId}` blocks on
 *  `gate` and calls `onReached` right before blocking — every later put
 *  (including retries) passes through unblocked. Mirrors the #725
 *  interleaved-adapter technique (`search-persist-flush-purge-race.test.ts`)
 *  for deterministically forcing the worst-case concurrent-CAS ordering. */
function gateFirstIndexPut(
  store: NoydbStore,
  targetId: string,
  hooks: { gate: () => Promise<void>; onReached: () => void },
): NoydbStore {
  let armed = true
  return {
    ...store,
    async put(v, c, id, env, ev) {
      if (armed && c === BLOB_INDEX_COLLECTION && id === targetId) {
        armed = false
        hooks.onReached()
        await hooks.gate()
      }
      return store.put(v, c, id, env, ev)
    },
  }
}

const VAULT = 'v'
const SECRET = 'correct-horse-battery-staple-long-enough'
const bytes = (s: string) => new TextEncoder().encode(s)

/** The private `BlobSet` surface these tests exercise directly. */
interface BlobSetInternals {
  loadBlobObject(
    eTag: string,
    tier?: number,
    alsoTryTier?: number,
  ): Promise<{ blob: BlobObject; version: number; atTier: number } | null>
  casUpdateRefCountStamped(
    eTag: string,
    delta: number,
    tier: number | undefined,
    stamp: string,
  ): Promise<{ applied: boolean; refCount: number }>
  releaseRef(
    eTag: string,
    n: number,
    reclaimLegacy: boolean,
    tier?: number,
    stamp?: string,
    chunkCountHint?: number,
  ): Promise<'shredded' | 'retainedShared' | 'residue'>
}

// ─── loadBlobObject: two-tier loader mode ─────────────────────────────────

describe('loadBlobObject — two-tier mode (#753 spec §7 C7/§2d)', () => {
  interface Doc { id: string; title: string }
  let store: NoydbStore

  beforeEach(() => { store = memoryStore() })

  it('opens-at-tier / opens-at-alsoTry / opens-at-neither / flat (today\'s default preserved)', async () => {
    const db = await createNoydb({
      store, secret: SECRET, user: 'owner',
      tiersStrategy: withTiers(), blobsStrategy: withBlobs(),
    })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1, 2], perRecordKeys: true, blobFields: { attachment: {} },
    })

    // Solo-owned blob, elevated (isolate/default policy) — forks a fresh
    // object physically encrypted under the tier-1 `_blob` DEK.
    await docs.putAtTier('iso', { id: 'iso', title: 'Isolated' }, 0)
    await docs.blob('iso').put('attachment', bytes('isolated tier-1 content'))
    await docs.elevate('iso', 1)
    const isoSet = await docs.blob('iso').atTier()
    const isoInternals = isoSet as unknown as BlobSetInternals
    const isoETag = (await isoSet.blobInfo('attachment'))!.eTag

    // opens-at-tier: primary tier (1) is correct — no fallback needed.
    const atFrom = await isoInternals.loadBlobObject(isoETag, 1, 0)
    expect(atFrom!.atTier).toBe(1)

    // opens-at-alsoTry: primary (0) is wrong, alsoTryTier (1) is correct.
    const atTo = await isoInternals.loadBlobObject(isoETag, 0, 1)
    expect(atTo!.atTier).toBe(1)

    // opens-at-neither: both primary (0) and alsoTryTier (2) are wrong for
    // this tier-1-keyed object — propagates TamperedError, doesn't swallow it.
    await expect(isoInternals.loadBlobObject(isoETag, 0, 2)).rejects.toBeInstanceOf(TamperedError)

    // flat: today's t>0→flat(0) default, preserved byte-identical when
    // alsoTryTier is OMITTED — a dedup-shared object stays flat even for an
    // elevated co-owner, and the default fallback must still find it.
    const docsDedup = vault.collection<Doc>('docsDedup', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
      blobTierPolicy: 'dedup',
    })
    const shared = bytes('shared dedup-policy content')
    await docsDedup.putAtTier('a', { id: 'a', title: 'A' }, 0)
    await docsDedup.blob('a').put('attachment', shared)
    await docsDedup.putAtTier('b', { id: 'b', title: 'B' }, 0)
    await docsDedup.blob('b').put('attachment', shared)
    await docsDedup.elevate('b', 1) // dedup policy: object left flat in place

    const sharedETag = (await docsDedup.blob('a').blobInfo('attachment'))!.eTag
    const bSet = await docsDedup.blob('b').atTier() // b's ownerTier() now resolves 1
    const bInternals = bSet as unknown as BlobSetInternals
    const flat = await bInternals.loadBlobObject(sharedETag) // no tier/alsoTryTier args
    expect(flat!.atTier).toBe(0)

    db.close()
  })
})

// ─── casUpdateRefCountStamped: in-loop test-and-set + ring eviction ───────

describe('casUpdateRefCountStamped (#753 spec §7 C2/C4)', () => {
  interface Doc { ref: string }
  let store: NoydbStore

  beforeEach(() => { store = memoryStore() })

  it('concurrent two-writer CAS racing the SAME stamp: exactly one applies', async () => {
    // Seed the blob via a plain (ungated) db/store pair — the eTag is
    // content-derived and only known after this write, so it can't be
    // named by the gate up front.
    const db0 = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const invoices0 = vault0.collection<Doc>('invoices', { perRecordKeys: true })
    await invoices0.put('inv-1', { ref: 'A' })
    await invoices0.blob('inv-1').put('receipt.pdf', bytes('race target content'))
    const eTag = (await invoices0.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    db0.close()

    // Reopen a second db instance against the SAME underlying store (the
    // owner keyring persisted by db0 unlocks identically under the same
    // user/secret — the standard cross-session pattern this suite already
    // uses elsewhere, e.g. `blob-set.test.ts`'s bundle round-trip), this
    // time wrapped so the FIRST `_blob_index/{eTag}` put blocks deterministically.
    let release!: () => void
    const gatePromise = new Promise<void>((r) => { release = r })
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const gated = gateFirstIndexPut(store, eTag, {
      gate: () => gatePromise,
      onReached: () => reached(),
    })

    const db = await createNoydb({ store: gated, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })
    const blobSet = invoices.blob('inv-1') as unknown as BlobSetInternals

    const stamp = 'race-stamp-1'
    const p1 = blobSet.casUpdateRefCountStamped(eTag, 5, undefined, stamp) // Writer 1: blocked mid-CAS
    await reachedPromise // Writer 1's put is now gated, holding the pre-write version

    // Writer 2 races in and lands cleanly against the SAME pre-write version.
    const r2 = await blobSet.casUpdateRefCountStamped(eTag, 5, undefined, stamp)
    expect(r2.applied).toBe(true)

    release() // Writer 1's stale put now resolves — conflicts, retries, sees the stamp
    const r1 = await p1

    // Exactly one of the two calls applied the delta.
    expect([r1.applied, r2.applied].filter(Boolean)).toHaveLength(1)
    expect(r1.applied).toBe(false)
    expect(r1.refCount).toBe(r2.refCount)

    const finalRefCount = (await (invoices.blob('inv-1') as unknown as BlobSetInternals).loadBlobObject(eTag))!.blob.refCount
    expect(finalRefCount).toBe(1 + 5) // initial refCount 1, delta applied exactly ONCE

    db.close()
  })

  it('ring eviction at K=8: only the 8 most recent stamps survive, oldest evicted first', async () => {
    const db = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('receipt.pdf', bytes('ring test content'))
    const eTag = (await invoices.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    const internals = invoices.blob('inv-1') as unknown as BlobSetInternals

    const stamps = Array.from({ length: 10 }, (_, i) => `stamp-${i}`)
    for (const stamp of stamps) {
      const r = await internals.casUpdateRefCountStamped(eTag, 0, undefined, stamp)
      expect(r.applied).toBe(true) // each is a distinct, never-before-seen stamp
    }

    const { blob } = (await internals.loadBlobObject(eTag))!
    expect(blob.lastOps).toHaveLength(8)
    expect(blob.lastOps).toEqual(stamps.slice(2)) // stamp-0 and stamp-1 evicted, oldest-first
    expect(blob.lastOps).not.toContain('stamp-0')
    expect(blob.lastOps).not.toContain('stamp-1')

    db.close()
  })
})

// ─── releaseRef: stamped two-armed resume rule ────────────────────────────

describe('releaseRef — stamped two-armed resume rule (#753 spec §7 C1)', () => {
  interface Doc { ref: string }
  let store: NoydbStore

  beforeEach(() => { store = memoryStore() })

  it('arm 1 (stamped && refCount > 0): skips re-decrementing on resume', async () => {
    const db = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })

    // Two co-owners share the content: refCount starts at 2.
    const content = bytes('shared receipt content')
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('receipt.pdf', content)
    await invoices.put('inv-2', { ref: 'B' })
    await invoices.blob('inv-2').put('receipt.pdf', content)
    const eTag = (await invoices.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    const internals = invoices.blob('inv-1') as unknown as BlobSetInternals
    expect((await internals.loadBlobObject(eTag))!.blob.refCount).toBe(2)

    const stamp = 'arm1-stamp'
    const outcome1 = await internals.releaseRef(eTag, 1, true, undefined, stamp)
    expect(outcome1).toBe('retainedShared')
    expect((await internals.loadBlobObject(eTag))!.blob.refCount).toBe(1)

    // Resume with the SAME stamp — the decrement already landed; must NOT
    // decrement again (would incorrectly drop the still-live co-owner's ref).
    const outcome2 = await internals.releaseRef(eTag, 1, true, undefined, stamp)
    expect(outcome2).toBe('retainedShared')
    expect((await internals.loadBlobObject(eTag))!.blob.refCount).toBe(1) // unchanged

    db.close()
  })

  it('arm 2 (stamped && refCount <= 0, index row still present): completes the deletion idempotently', async () => {
    const db = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('receipt.pdf', bytes('solo receipt content'))
    const eTag = (await invoices.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    const internals = invoices.blob('inv-1') as unknown as BlobSetInternals

    // Apply the stamped decrement directly (bypassing releaseRef's own
    // deletion step) to simulate a crash landing exactly between the
    // decrement CAS and the index+chunk deletion.
    const stamp = 'arm2-stamp'
    const { refCount } = await internals.casUpdateRefCountStamped(eTag, -1, undefined, stamp)
    expect(refCount).toBe(0)
    expect(await internals.loadBlobObject(eTag)).not.toBeNull() // index row still present
    expect(await store.get(VAULT, BLOB_CHUNKS_COLLECTION, `${eTag}_0`)).not.toBeNull()

    const outcome = await internals.releaseRef(eTag, 1, true, undefined, stamp)
    expect(outcome).toBe('shredded')
    expect(await internals.loadBlobObject(eTag)).toBeNull()
    expect(await store.get(VAULT, BLOB_CHUNKS_COLLECTION, `${eTag}_0`)).toBeNull()

    db.close()
  })

  it('arm 2 (index row already gone): chunkCountHint completes chunk cleanup idempotently', async () => {
    const db = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('receipt.pdf', bytes('solo receipt content, part 2'))
    const eTag = (await invoices.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    const internals = invoices.blob('inv-1') as unknown as BlobSetInternals
    const chunkCount = (await internals.loadBlobObject(eTag))!.blob.chunkCount

    const stamp = 'arm2-index-gone-stamp'
    const { refCount } = await internals.casUpdateRefCountStamped(eTag, -1, undefined, stamp)
    expect(refCount).toBe(0)

    // Simulate the deeper crash point: the index row itself was ALREADY
    // deleted (the resume's own prior attempt got that far) but the chunk
    // loop never completed.
    await store.delete(VAULT, BLOB_INDEX_COLLECTION, eTag)
    expect(await store.get(VAULT, BLOB_CHUNKS_COLLECTION, `${eTag}_0`)).not.toBeNull()

    const outcome = await internals.releaseRef(eTag, 1, true, undefined, stamp, chunkCount)
    expect(outcome).toBe('shredded')
    for (let i = 0; i < chunkCount; i++) {
      expect(await store.get(VAULT, BLOB_CHUNKS_COLLECTION, `${eTag}_${i}`)).toBeNull()
    }

    db.close()
  })

  it('unstamped releaseRef calls remain byte-identical (no lastOps written)', async () => {
    const db = await createNoydb({ store, secret: SECRET, user: 'a', blobsStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Doc>('invoices', { perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('receipt.pdf', bytes('unstamped content'))
    const eTag = (await invoices.blob('inv-1').blobInfo('receipt.pdf'))!.eTag
    const internals = invoices.blob('inv-1') as unknown as BlobSetInternals

    const outcome = await internals.releaseRef(eTag, 1, true)
    expect(outcome).toBe('shredded')
    expect(await internals.loadBlobObject(eTag)).toBeNull()

    db.close()
  })
})
