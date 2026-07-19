/**
 * `rehomeForTier` destination-increment stamping — PR-2 Task 1 (#746 spec §7
 * C3, the rehome correctness core).
 *
 * The hazard: `rehomeForTier`'s DESTINATION refCount `+1`s (`putUnderDEK`'s
 * dedup-hit re-put, `rehomeVersionETag`'s own increment) crash-window
 * over-count on a naive resumed re-put — the destination object's refCount
 * inflates past its true hold count, so it never reaches 0 and its content
 * is never crypto-shredded even after every legitimate holder is gone (a
 * silent, permanent leak).
 *
 * This task threads an optional `opId` through `rehomeForTier` /
 * `putUnderDEK` / `rehomeVersionETag` / `writeBlobContent`. When present,
 * every destination `+1` carries a ROW-SCOPED stamp (`${opId}:${slotName}`
 * / `${opId}:${versionKey}`) — never the bare opId, which could not tell N
 * legitimate slots/versions apart when they all land on ONE destination
 * eTag. PR-1's `casUpdateRefCountStamped` in-loop membership check (spec
 * C2/C4) is what makes a re-applied `+1` under the SAME stamp a no-op.
 *
 * Task 2 (PR-2) wires the actual `_blob_intent` rehome marker mint/consume
 * and full per-step resume tolerance (including the two-tier slot-map load
 * that lets a resumed call proceed once the slot map has already physically
 * moved to `toTier`). Task 1 does NOT have that fallback yet — so these
 * tests choose crash points that stay resumable with Task 1 alone: the slot
 * case crashes strictly BEFORE the slot map's own CAS write lands (so the
 * map is untouched on resume); the version case uses a record with NO slot
 * row at all (so `rehomeForTier`'s slot block never runs and the
 * `loadSlots(fromTier)` call at entry always sees a clean, tier-agnostic
 * absent row). Full half-moved-slot-map resumability is Task 2's job.
 *
 * STOP-model crash injection (hang-forever adapter wrappers), mirroring
 * `blob-shred-journal.test.ts` / `blob-journal-primitives.test.ts` — NOT
 * throw-and-catch: a real crash kills the process mid-write, so nothing
 * ever catches it and nothing after it ever runs.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, BlobObject, SlotRecord } from '../src/kernel/types.js'

const SECRET = 'blob-rehome-journal-test-passphrase'
const bytes = (s: string) => new TextEncoder().encode(s)

// ─── Store ──────────────────────────────────────────────────────────────

function memory(): NoydbStore & {
  raw(v: string, col: string, id: string): EncryptedEnvelope | undefined
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

/** Hang forever on the Nth `put` matching `match` (see blob-shred-journal.test.ts's twin). */
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

/** Hang forever on the Nth `delete` matching `match`. */
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

interface Doc { id: string; title: string }

const VAULT = 'v'
const SLOTS_COLLECTION = '_blob_slots_docs'
const INDEX_COLLECTION = '_blob_index'
const VERSIONS_COLLECTION = '_blob_versions_docs'
const CHUNKS_COLLECTION = '_blob_chunks'

/** The private `BlobSet` surface these tests reach directly — same cast pattern as blob-journal-primitives.test.ts. */
interface BlobSetInternals {
  loadBlobObject(eTag: string, tier?: number, alsoTryTier?: number): Promise<{ blob: BlobObject; version: number; atTier: number } | null>
  loadSlots(tier?: number): Promise<{ slots: Record<string, SlotRecord>; version: number }>
}

// ─── Slot re-put: destination +1 lands, crash before the slot CAS ────────

describe('rehomeForTier — slot re-put destination +1 is row-scoped stamped (#746 spec C3)', () => {
  it('crash after the destination +1 lands, before the slot CAS → resume does not over-count; old object released exactly once', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const shared = bytes('content shared across the tier-1 dedup pool')

    // Seed a pre-existing tier-1 destination object with the SAME content —
    // 'r's own rehome below will dedup-HIT it, not create it, so its `+1`
    // is a genuine CAS increment (the hazard C3 targets).
    await docs0.putAtTier('seed', { id: 'seed', title: 'Seed' }, 0)
    await docs0.blob('seed').put('attachment', shared)
    await docs0.elevate('seed', 1) // unstamped rehome — creates the tier-1 object at refCount 1
    const seedAtTier = await docs0.blob('seed').atTier()
    const destETag = (await seedAtTier.blobInfo('attachment'))!.eTag
    expect((await seedAtTier.blobInfo('attachment'))!.refCount).toBe(1)

    await docs0.putAtTier('r', { id: 'r', title: 'R' }, 0)
    await docs0.blob('r').put('attachment', shared)
    const oldETag = (await docs0.blob('r').blobInfo('attachment'))!.eTag
    db0.close()

    // Crash exactly after the destination `+1` (a `_blob_index/{destETag}`
    // CAS write) lands for real, but before the slot CAS (the FIRST
    // `_blob_slots_docs` put in this session) — which hangs forever.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === SLOTS_COLLECTION, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const opId = 'rehome-op-slot-1'
    void docsCrash.blob('r').rehomeForTier(0, 1, 'isolate', opId) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Mid-crash: the destination `+1` landed for real (refCount 2). The old
    // tier-0 object is UNTOUCHED (its release happens after the slot CAS,
    // which never landed). The slot map is unchanged (still tier-0-keyed,
    // still pointing at oldETag).
    const destInternals = docsCrash.blob('seed') as unknown as BlobSetInternals
    expect((await destInternals.loadBlobObject(destETag, 1))!.blob.refCount).toBe(2)
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeDefined()

    // Resume: fresh session, same store, same opId — re-running
    // `rehomeForTier` from scratch. The slot map never moved, so
    // `loadSlots(fromTier)` still resolves cleanly.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r').rehomeForTier(0, 1, 'isolate', opId)

    // THE regression check: the destination refCount is 2, NOT 3 — the
    // resumed re-put's `+1` was skipped (already stamped), not re-applied.
    const resumeInternals = docsResume.blob('seed') as unknown as BlobSetInternals
    const finalDest = await resumeInternals.loadBlobObject(destETag, 1)
    expect(finalDest!.blob.refCount).toBe(2)

    // The old tier-0 object was released exactly once (fully gone, not
    // double-decremented into a negative/stranded count).
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeUndefined()

    // 'r's slot map physically moved to tier 1 and now resolves to the
    // destination object. (`rehomeForTier` alone — called directly here,
    // bypassing `elevate()` — never touches the record's own `_tier`
    // field, so `blobInfo()`'s live-tier-driven default resolution can't be
    // used for this check; read the slot map directly at tier 1 instead.)
    const rInternals = docsResume.blob('r') as unknown as BlobSetInternals
    const { slots: rSlots } = await rInternals.loadSlots(1)
    expect(rSlots.attachment!.eTag).toBe(destETag)

    dbResume.close()
  })
})

// ─── Solo-blob (fresh-create) destination: crash right after the CREATE ──

describe('rehomeForTier — fresh-object CREATE also seeds the stamp (#746 C3 review)', () => {
  it('crash after the fresh-create lands, before the slot CAS → resume does not spuriously double the destination refCount', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    // NO pre-seeded tier-1 destination this time: 'r4' is the FIRST (and
    // only) holder of this content at either tier — its rehome's Step 6 is
    // a fresh CREATE, not a dedup-hit CAS. This is the branch the review
    // caught unstamped: a resumed re-put's Step 3 dedup-hits the object
    // ITS OWN prior (crashed) attempt created, and without a seeded stamp
    // there is nothing to skip against.
    await docs0.putAtTier('r4', { id: 'r4', title: 'R4' }, 0)
    await docs0.blob('r4').put('attachment', bytes('solo content, no pre-existing destination'))
    const oldETag = (await docs0.blob('r4').blobInfo('attachment'))!.eTag
    db0.close()

    // Crash exactly after the fresh-create (a `_blob_index/{destETag}` PUT)
    // lands for real, but before the slot CAS (the FIRST `_blob_slots_docs`
    // put in this session) — which hangs forever.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === SLOTS_COLLECTION, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const opId = 'rehome-op-fresh-create-1'
    void docsCrash.blob('r4').rehomeForTier(0, 1, 'isolate', opId) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Mid-crash: exactly two `_blob_index` rows exist — the untouched old
    // (tier-0) object and the freshly-created destination. Identify the
    // destination by elimination (no pre-seed to read its eTag off of).
    const indexKeysMidCrash = await store.list(VAULT, INDEX_COLLECTION)
    expect(indexKeysMidCrash).toHaveLength(2)
    const destETag = indexKeysMidCrash.find((k) => k !== oldETag)!
    const destInternals = docsCrash.blob('r4') as unknown as BlobSetInternals
    const midCrashDest = await destInternals.loadBlobObject(destETag, 1)
    expect(midCrashDest!.blob.refCount).toBe(1) // correct: exactly one create, no dedup-hit yet
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeDefined() // old object untouched (release not reached)

    // Resume: fresh session, same store, same opId — re-running
    // `rehomeForTier` from scratch. The slot map never moved, so
    // `loadSlots(fromTier)` still resolves cleanly.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r4').rehomeForTier(0, 1, 'isolate', opId)

    // THE regression check (the review's HIGH finding): the destination
    // refCount is 1, NOT 2 — the resumed re-put's Step 3 dedup-hit against
    // the object its OWN crashed attempt created found the SEEDED stamp
    // already present and skipped, instead of spuriously incrementing.
    const resumeInternals = docsResume.blob('r4') as unknown as BlobSetInternals
    const finalDest = await resumeInternals.loadBlobObject(destETag, 1)
    expect(finalDest!.blob.refCount).toBe(1)

    // The old tier-0 object was released exactly once (fully gone).
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeUndefined()

    // 'r4's slot map physically moved to tier 1 and now resolves to the
    // destination object.
    const rInternals = docsResume.blob('r4') as unknown as BlobSetInternals
    const { slots: rSlots } = await rInternals.loadSlots(1)
    expect(rSlots.attachment!.eTag).toBe(destETag)

    dbResume.close()
  })
})

// ─── Version re-put: destination +1 lands, crash before the release completes ─

describe('rehomeForTier — version re-put destination +1 is row-scoped stamped (#746 spec C3)', () => {
  it('crash after the destination +1 lands (version fallback re-put), before the old object\'s deletion completes → resume does not over-count', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const shared = bytes('version-held content, tier-1 dedup pool')

    // Seed a pre-existing tier-1 destination object with the SAME content.
    await docs0.putAtTier('seed2', { id: 'seed2', title: 'Seed2' }, 0)
    await docs0.blob('seed2').put('attachment', shared)
    await docs0.elevate('seed2', 1)
    const seed2AtTier = await docs0.blob('seed2').atTier()
    const destETag = (await seed2AtTier.blobInfo('attachment'))!.eTag
    expect((await seed2AtTier.blobInfo('attachment'))!.refCount).toBe(1)

    // 'r3': attach the content, publish a version pointing at it, then
    // DELETE the slot entirely — the slot map row is fully removed (empty
    // map → row deleted, `casUpdateSlots`'s own convention), leaving the
    // PUBLISHED VERSION as the eTag's sole remaining holder. This keeps
    // `rehomeForTier`'s slot block a complete no-op on resume (no
    // half-moved slot map to fall over) while still exercising a genuine
    // "version +1" destination increment via the `writeBlobContent`
    // dedup-hit path `rehomeVersionETag` shares with `putUnderDEK`.
    await docs0.putAtTier('r3', { id: 'r3', title: 'R3' }, 0)
    await docs0.blob('r3').put('attachment', shared)
    await docs0.blob('r3').publish('attachment', 'v1')
    const oldETag = (await docs0.blob('r3').blobInfo('attachment'))!.eTag
    expect((await docs0.blob('r3').blobInfo('attachment'))!.refCount).toBe(2) // slot + version holds
    await docs0.blob('r3').delete('attachment') // slot hold released; version-only from here
    expect(store.raw(VAULT, SLOTS_COLLECTION, 'r3')).toBeUndefined() // row gone, per casUpdateSlots convention
    db0.close()

    // Crash after the destination `+1` (the version's dedup-hit re-put)
    // lands for real, and after the old object's refCount CAS decrement
    // (1 → 0, stamped) also lands, but before the old object's index-row
    // DELETE completes (the `_blob_index/{oldETag}` delete hangs forever).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthDelete(store, (col, id) => col === INDEX_COLLECTION && id === oldETag, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const opId = 'rehome-op-version-1'
    void docsCrash.blob('r3').rehomeForTier(0, 1, 'isolate', opId) // fire-and-forget: never settles
    await reachedPromise

    // Mid-crash: destination `+1` landed for real (refCount 2). The old
    // object's row is still PHYSICALLY present (delete hung) but its
    // refCount CAS already dropped to 0 and it's already stamped.
    const destInternals = docsCrash.blob('seed2') as unknown as BlobSetInternals
    expect((await destInternals.loadBlobObject(destETag, 1))!.blob.refCount).toBe(2)
    const strandedOld = store.raw(VAULT, INDEX_COLLECTION, oldETag)
    expect(strandedOld).toBeDefined() // row not yet deleted
    // The published version row is untouched (its own re-key write never landed).
    expect(store.raw(VAULT, VERSIONS_COLLECTION, 'r3::attachment::v1')).toBeDefined()

    // Resume: fresh session, same store, same opId. 'r3' has NO slot row —
    // `loadSlots(fromTier)` sees a clean absent row regardless of any prior
    // partial move, so the full `rehomeForTier` re-run is safe with
    // Task 1's code alone (no two-tier slot-map fallback needed here).
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r3').rehomeForTier(0, 1, 'isolate', opId)

    // THE regression check: the destination refCount is 2, NOT 3 — the
    // resumed re-put's `+1` was skipped (already stamped).
    const resumeInternals = docsResume.blob('seed2') as unknown as BlobSetInternals
    const finalDest = await resumeInternals.loadBlobObject(destETag, 1)
    expect(finalDest!.blob.refCount).toBe(2)

    // The old object was released exactly once: its decrement landed only
    // during the crashed run (never re-applied on resume); resume merely
    // COMPLETED the interrupted deletion (idempotent, C1's completion arm).
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeUndefined()
    expect(store.raw(VAULT, CHUNKS_COLLECTION, `${oldETag}_0`)).toBeUndefined()

    dbResume.close()
  })
})

// ─── Unstamped rehome stays byte-identical (no opId → no footprint) ──────

describe('rehomeForTier — unstamped (no opId) call is byte-identical to today', () => {
  it('a direct call with no opId increments refCount normally and leaves no lastOps stamp', async () => {
    const store = memory()
    const db = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const shared = bytes('unstamped-path content')

    // Direct `rehomeForTier` calls never touch the record's own `_tier`
    // field (only `elevate()`/`syncTierMove` does — see its own doc
    // comment), so read the moved slot map/blob object directly at tier 1
    // via the internal surface (mirrors this file's other direct-call
    // tests) instead of `atTier()`, which resolves off the LIVE record tier.
    await docs.putAtTier('seed3', { id: 'seed3', title: 'Seed3' }, 0)
    await docs.blob('seed3').put('attachment', shared)
    await docs.blob('seed3').rehomeForTier(0, 1, 'isolate') // direct call, no opId
    const seed3Internals = docs.blob('seed3') as unknown as BlobSetInternals
    const { slots: seed3Slots } = await seed3Internals.loadSlots(1)
    const destETag = seed3Slots.attachment!.eTag

    await docs.putAtTier('u', { id: 'u', title: 'U' }, 0)
    await docs.blob('u').put('attachment', shared)
    await docs.blob('u').rehomeForTier(0, 1, 'isolate') // no opId — byte-identical to pre-#746 behavior

    const destInternals = docs.blob('seed3') as unknown as BlobSetInternals
    const dest = await destInternals.loadBlobObject(destETag, 1)
    expect(dest!.blob.refCount).toBe(2) // seed3's create + u's dedup-hit — ordinary behavior
    expect(dest!.blob.lastOps ?? []).toEqual([]) // no stamp recorded — zero footprint when opId is omitted

    db.close()
  })
})

// ─── syncBlobs (elevate/demote) now mints a real, stamped marker (#746 T2) ─

describe('syncBlobs mints a rehome marker with a FRESH opId per move (#746 spec §7 §2d)', () => {
  it('elevate() leaves a stamp on the destination and no dangling marker; two records elevated in sequence get DIFFERENT opIds', async () => {
    const store = memory()
    const db = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const shared = bytes('syncBlobs-path content')

    await docs.putAtTier('seed4', { id: 'seed4', title: 'Seed4' }, 0)
    await docs.blob('seed4').put('attachment', shared)
    await docs.elevate('seed4', 1) // now goes through syncTierMove: mints+stamps+deletes its own marker
    const seed4AtTier = await docs.blob('seed4').atTier()
    const destETag = (await seed4AtTier.blobInfo('attachment'))!.eTag
    const destInternals = docs.blob('seed4') as unknown as BlobSetInternals
    const afterFirst = await destInternals.loadBlobObject(destETag, 1)
    expect(afterFirst!.blob.refCount).toBe(1)
    expect(afterFirst!.blob.lastOps).toHaveLength(1) // seed4's own create is now stamped

    await docs.putAtTier('u2', { id: 'u2', title: 'U2' }, 0)
    await docs.blob('u2').put('attachment', shared)
    await docs.elevate('u2', 1) // a SECOND, independent syncTierMove — its own fresh opId

    const afterSecond = await destInternals.loadBlobObject(destETag, 1)
    expect(afterSecond!.blob.refCount).toBe(2) // seed4's create + u2's dedup-hit
    expect(afterSecond!.blob.lastOps).toHaveLength(2) // two DIFFERENT stamps — never the same opId reused across records

    // No dangling `_blob_intent` markers after either move.
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    db.close()
  })
})

// ─── PR-2 Task 2: full crash-atomic resumability (marker mint/resume/consume) ─

/**
 * Below: the PR-2 Task 2 STOP-model matrix — real marker mint (`syncTierMove`,
 * via `elevate()`), real crash injection, real resume through a PRODUCTION
 * entry point (a subsequent tier op or an ordinary blob write), never a
 * hand-planted marker or a bare `rehomeForTier(..., opId)` call. Task 1's
 * tests above proved the STAMPING primitive; these prove the SEAM: mint
 * before the first write, per-step from-then-to tolerance, and consume
 * (delete) only once every phase completes.
 *
 * Note on "resume via elevate()": `elevate()` no-ops at the collection level
 * when the record's `_tier` already equals the target (`if (toTier ===
 * fromTier) return` — BEFORE `syncBlobs`/`syncTierMove` is ever called), and
 * a crashed run's RECORD write always lands before its BLOB rehome does
 * (`elevate()` writes the record, then calls `syncBlobs` last) — so a
 * same-tier re-`elevate()` is never the resuming call in practice. The tests
 * below resume either via elevating a STRANDED record to a FURTHER tier
 * (`syncTierMove`'s own `resolvePendingIntent()` pre-check resumes the stale
 * marker first, using ITS OWN captured fromTier/toTier/opId, before the new
 * move proceeds) or via an ordinary blob write (`put()`), both real §2d
 * "who resumes" paths.
 */

describe('mid per-eTag loop crash → resume via a subsequent elevate() attempt (#746 spec §7 §2d)', () => {
  it('two-slot record: one eTag fully moved, one crashed mid-move → resume completes both (mixed alsoTryTier from-then-to open), releases every intermediate object once, marker gone; demote reversal round-trips', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })

    await docs0.putAtTier('mixed', { id: 'mixed', title: 'Mixed' }, 0)
    await docs0.blob('mixed').put('a', bytes('content A'))
    await docs0.blob('mixed').put('b', bytes('content B'))
    const oldA = (await docs0.blob('mixed').blobInfo('a'))!.eTag
    const oldB = (await docs0.blob('mixed').blobInfo('b'))!.eTag
    db0.close()

    // Crash `elevate(0→1)` exactly after slot 'a's full move (content
    // create + slot CAS + old-object release, in that order) but mid slot
    // 'b's (its destination content already created — Step 6 of
    // `writeBlobContent`, which precedes the slot CAS — but its OWN slot
    // CAS never lands): hang on the 2nd `_blob_slots_docs` put.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === SLOTS_COLLECTION, 2, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })
    void docsCrash.elevate('mixed', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Mid-crash: the record's own `_tier` already shows 1 (elevate() writes
    // the record BEFORE calling syncBlobs); the rehome marker is pending.
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1)
    expect(store.raw(VAULT, INDEX_COLLECTION, oldA)).toBeUndefined() // slot a's old object: released
    expect(store.raw(VAULT, INDEX_COLLECTION, oldB)).toBeDefined() // slot b's old object: untouched (release never reached)

    // Resume: a fresh session, elevate to a FURTHER tier (2). `syncTierMove`
    // resumes the STALE 0→1 marker first (per-eTag: 'a' already opens at
    // tier 1 → skip; 'b' still opens at tier 0 → resume it — the mixed
    // record this describe block is named for), deletes it, THEN runs its
    // own fresh 1→2 move.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })
    await docsResume.elevate('mixed', 2)

    const atTier2 = await docsResume.blob('mixed').atTier()
    expect(await atTier2.get('a')).toEqual(bytes('content A'))
    expect(await atTier2.get('b')).toEqual(bytes('content B'))

    // Every intermediate object (tier 0 AND the transient tier-1 landing)
    // was released exactly once — nothing stranded.
    expect(store.raw(VAULT, INDEX_COLLECTION, oldA)).toBeUndefined()
    expect(store.raw(VAULT, INDEX_COLLECTION, oldB)).toBeUndefined()

    // No marker left behind by either the resumed 0→1 move or the fresh 1→2 one.
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    // Demote reversal still round-trips.
    await docsResume.demote('mixed', 0)
    expect(await docsResume.blob('mixed').get('a')).toEqual(bytes('content A'))
    expect(await docsResume.blob('mixed').get('b')).toEqual(bytes('content B'))

    dbResume.close()
  })
})

describe('crash after the slot map fully moves → resume skips the move and completes the version pass (#746 spec §7 §2d)', () => {
  it('a shared-eTag version (finding (a): the already-rehomed fast path, now reachable) and a unique-content version both resolve correctly on resume', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    // 'r5': slot 'a' published as 'v1' (v1 holds the SAME eTag as the slot —
    // the "already"-rehomed fast-path case). A second, unrelated slot
    // 'temp' is published as 'v2' then deleted — v2's content survives ONLY
    // as a published version, sharing nothing with any live slot (the
    // "fresh" re-put case, same shape as this file's earlier version test).
    await docs0.putAtTier('r5', { id: 'r5', title: 'R5' }, 0)
    await docs0.blob('r5').put('a', bytes('slot-and-version content'))
    await docs0.blob('r5').publish('a', 'v1')
    await docs0.blob('r5').put('temp', bytes('version-only content'))
    await docs0.blob('r5').publish('temp', 'v2')
    await docs0.blob('r5').delete('temp')
    db0.close()

    // Crash exactly after the SLOT section fully completes (content move +
    // slot CAS + old-object release + the final whole-map `saveSlots` move)
    // but before EITHER version's own metadata write lands: hang on the
    // FIRST `_blob_versions_docs` put. A fresh resume session therefore
    // starts with the slot map ALREADY open at `toTier` and an EMPTY
    // in-memory `rehomedETags` — the reconstruction branch (not the
    // trivial same-call fast path) is what makes v1's "already" lookup hit.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === VERSIONS_COLLECTION, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    void docsCrash.elevate('r5', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Mid-crash: the slot map is already tier-1-keyed (the move landed).
    const slotInternals = docsCrash.blob('r5') as unknown as BlobSetInternals
    const { slots: midSlots } = await slotInternals.loadSlots(1)
    expect(midSlots.a).toBeDefined() // opens cleanly at tier 1 — the move completed
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1) // marker still pending — neither version's metadata moved yet

    // Resume via an ORDINARY write (put()) — the record's `_tier` already
    // shows 1, so (per this file's other tests) a same-tier `elevate()`
    // would no-op at the collection level; `put()`'s `resolvePendingIntent()`
    // gate is the resuming entry point here instead.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r5').put('unrelated', bytes('triggers resume'))

    expect(await store.list(VAULT, '_blob_intent')).toEqual([]) // marker consumed

    const atTier = await docsResume.blob('r5').atTier()
    expect(await atTier.getVersion('a', 'v1')).toEqual(bytes('slot-and-version content'))
    expect(await atTier.getVersion('temp', 'v2')).toEqual(bytes('version-only content'))

    dbResume.close()
  })
})

// ─── The slot-CAS→deferred-release gap (carried finding (b)) ────────────

describe('the slot-CAS→deferred-release gap is closed by the pendingRelease breadcrumb (#746 review, carried finding (b))', () => {
  it('crash exactly after the slot CAS lands (slot already points at the new eTag) but before the old-object release even starts → resume finds the old eTag via the breadcrumb, not the (now-overwritten) slot map — no stranded hold', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })

    await docs0.putAtTier('strand', { id: 'strand', title: 'Strand' }, 0)
    await docs0.blob('strand').put('a', bytes('solo content'))
    const oldETag = (await docs0.blob('strand').blobInfo('a'))!.eTag
    db0.close()

    // The hazard this test isolates: `putUnderDEK`'s slot-CAS (pointing the
    // slot at its NEW eTag) and its old-eTag release are two SEPARATE
    // writes. Once the CAS lands, `oldETag` is no longer discoverable via
    // ANY re-derivation from the (now-overwritten) live slot map — a plain
    // re-run of the per-eTag loop would never revisit it, permanently
    // stranding its refcount (a leak, never crypto-shredded). Crash exactly
    // on the FIRST `_blob_index` write to `oldETag` itself (the release's
    // OWN CAS decrement) — this can only fire AFTER the slot CAS already
    // landed for real (the release is sequenced strictly after it in
    // `putUnderDEK`).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col, id) => col === INDEX_COLLECTION && id === oldETag, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })
    void docsCrash.elevate('strand', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // Mid-crash: the slot already points at the NEW eTag (the CAS landed);
    // the breadcrumb durably records the OLD one; the old object is
    // completely untouched (its release never even started). The slot map
    // ITSELF is still physically keyed at `fromTier` (0) — its own re-key
    // to `toTier` is the LAST step of the slot section, still pending.
    const slotInternals = docsCrash.blob('strand') as unknown as BlobSetInternals
    const { slots: midSlots } = await slotInternals.loadSlots(0)
    expect(midSlots.a!.eTag).not.toBe(oldETag)
    expect(midSlots.a!.pendingRelease).toBe(oldETag)
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeDefined() // untouched — not even decremented yet

    // Resume: a fresh session, elevate to a FURTHER tier (a same-tier
    // re-`elevate()` would no-op at the collection level — see this file's
    // other resume tests' shared note).
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })
    await docsResume.elevate('strand', 2)

    // The old (tier-0) object is fully released — gone, not stranded.
    expect(store.raw(VAULT, INDEX_COLLECTION, oldETag)).toBeUndefined()
    // The breadcrumb is cleared (not left behind as stale bookkeeping) and
    // never leaks through the public `list()` surface.
    const atTier = await docsResume.blob('strand').atTier()
    const finalList = await atTier.list()
    const slotA = finalList.find((s) => s.name === 'a')!
    expect(slotA).not.toHaveProperty('pendingRelease')
    expect(await atTier.get('a')).toEqual(bytes('solo content'))

    // No dangling marker.
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    dbResume.close()
  })
})

// ─── #746 review Critical 2: dedup reconstruction is tier-aware ─────────

describe('#746 review Critical 2 — the "already moved" reconstruction is tier-aware (DEK-mismatch fix)', () => {
  it('a shared (refCount>1) dedup-policy slot resumes cleanly: reconstruction leaves the still-flat object alone instead of unwrapping it under the wrong DEK', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true, blobTierPolicy: 'dedup' })

    // Two records dedup-hit the SAME content at tier 0 → refCount 2. Under
    // `blobTierPolicy: 'dedup'`, rehoming 'r1' alone must leave the shared
    // object flat (#741) — only 'r1's slot MAP entry (metadata) moves, the
    // eTag it points at stays unchanged.
    const shared = bytes('dedup-shared content')
    await docs0.putAtTier('r1', { id: 'r1', title: 'R1' }, 0)
    await docs0.blob('r1').put('a', shared)
    await docs0.putAtTier('r2', { id: 'r2', title: 'R2' }, 0)
    await docs0.blob('r2').put('a', shared) // dedup hit at tier 0 → refCount 2
    const sharedETag = (await docs0.blob('r1').blobInfo('a'))!.eTag
    expect((await docs0.blob('r1').blobInfo('a'))!.refCount).toBe(2)
    db0.close()

    // Crash `elevate('r1', 1)` exactly on the marker's OWN delete (the
    // LAST step) — the slot section (dedup no-op content skip + the final
    // whole-map `saveSlots` move) fully completes for real; only the
    // `_blob_intent` marker's own delete hangs. This is what makes a LATER
    // resume re-enter `runRehomeSteps` with the slot map ALREADY open at
    // `toTier` — the "already fully moved" reconstruction branch Critical
    // 2 targets.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthDelete(store, (col) => col === '_blob_intent', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true, blobTierPolicy: 'dedup' })
    void docsCrash.elevate('r1', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1) // marker still pending (its own delete hung)
    expect(store.raw(VAULT, INDEX_COLLECTION, sharedETag)).toBeDefined() // the shared object is genuinely untouched

    // Resume: a fresh session, elevate to a FURTHER tier — `syncTierMove`
    // resumes the STALE 0→1 marker first (per this file's other resume
    // tests' shared note on why a same-tier re-`elevate()` can't be the
    // resuming call), re-entering `runRehomeSteps` with the slot map
    // already at tier 1.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1, 2], perRecordKeys: true, blobTierPolicy: 'dedup' })

    // THE regression check: resume must COMPLETE — pre-fix, the
    // reconstruction branch's `loadBlobObject(eTag, toTier)` call (no
    // `alsoTryTier`) silently opened the still-flat shared object at tier 0
    // via its own default fallback, passed the `_cek !== undefined` check
    // (a dedup-retained object IS erasable, just left in place), and then
    // unwrapped its `_cek` under `toBlobDEK` (tier 1) — a DEK mismatch,
    // throwing uncaught and leaving resume permanently stuck.
    await expect(docsResume.elevate('r1', 2)).resolves.toEqual({ searchResidue: false })

    expect(await store.list(VAULT, '_blob_intent')).toEqual([]) // no dangling marker

    // The shared object is STILL correctly flat (never moved — #741) and
    // reads correctly for BOTH records.
    expect(store.raw(VAULT, INDEX_COLLECTION, sharedETag)).toBeDefined()
    expect((await docsResume.blob('r2').blobInfo('a'))!.refCount).toBe(2)
    const r1AtTier = await docsResume.blob('r1').atTier()
    expect(await r1AtTier.get('a')).toEqual(shared)
    expect(await docsResume.blob('r2').get('a')).toEqual(shared)

    dbResume.close()
  })
})

// ─── Q1 direction 2: the rehome entry resumes a pending SHRED marker first ─

describe('elevate() resumes a pending SHRED marker first — nothing left to rehome (#746/#753 spec Q1)', () => {
  it('a stranded shred marker (a previous forget() crashed right after minting it) is resumed by the next elevate(): the blob is erased, not moved, and elevate() still completes the record\'s own tier move', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs0.putAtTier('r', { id: 'r', title: 'R' }, 0)
    await docs0.blob('r').put('a', bytes('content the shred must erase'))
    const eTag = (await docs0.blob('r').blobInfo('a'))!.eTag

    // Simulate a forget() that crashed right after minting the marker (C5's
    // pre-tombstone step) but before shredding — mirrors
    // blob-shred-journal.test.ts's C4 setup. The record's OWN row is
    // untouched (no tombstone) — only the blob-side marker is pending.
    await docs0.blob('r').mintShredIntent(0)
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1)
    db0.close()

    // A rehome entry (`elevate`) on this SAME record must resume the
    // pending shred FIRST — "nothing left to rehome" once shred takes
    // over — rather than trying to move blobs the shred is about to erase.
    const db = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await expect(docs.elevate('r', 1)).resolves.toEqual({ searchResidue: false })

    // The blob is ERASED (shredded), not moved: no destination object at
    // tier 1, the original object gone, no slot map row.
    expect(store.raw(VAULT, INDEX_COLLECTION, eTag)).toBeUndefined()
    expect(store.raw(VAULT, CHUNKS_COLLECTION, `${eTag}_0`)).toBeUndefined()
    expect(store.raw(VAULT, SLOTS_COLLECTION, 'r')).toBeUndefined()
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    // `elevate()` still completed the record's OWN tier move — the shred
    // resume only cleared the blob side, it didn't abort the caller's ask.
    expect(store.raw(VAULT, 'docs', 'r')!._tier).toBe(1)

    db.close()
  })
})

// ─── Q1 direction 3: no path mints a second marker over a pending one ────

describe('a pending REHOME marker is never overwritten by a fresh SHRED marker (#746/#753 spec Q1/C8, single-marker-per-record)', () => {
  it('mintShredIntent() discovering a stranded rehome marker returns without minting — a later write resumes the REHOME (content preserved), never a spurious shred (content destroyed)', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs0.putAtTier('r', { id: 'r', title: 'R' }, 0)
    const original = bytes('content that must survive — proves no double marker')
    await docs0.blob('r').put('a', original)
    db0.close()

    // Strand a REHOME marker: crash `elevate()` exactly before the slot CAS
    // lands (same crash point as this file's other tests).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === SLOTS_COLLECTION, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    void docsCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1)

    // Fresh session: a call that would mint a SHRED marker for this SAME
    // record (mirrors `forget()`'s own pre-tombstone `mintShredIntent`
    // racing a pending rehome) — C8: the CAS create-if-absent refuses to
    // overwrite the pending marker; `mintShredIntent` discovers the raced
    // rehome marker and returns WITHOUT minting a fresh shred marker.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await expect(docsResume.blob('r').mintShredIntent(0)).resolves.toBeUndefined()

    // Exactly one marker still present — never two, never replaced.
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1)

    // THE regression check: an ordinary write's resume gate
    // (`resolvePendingIntent`) resumes whichever marker actually governs.
    // If `mintShredIntent` HAD clobbered it with a fresh SHRED marker, this
    // write would resume a SHRED — erasing `original` — instead of a
    // REHOME — moving it. The content surviving, readable at tier 1, is
    // the proof no second marker was ever minted over the pending one.
    await docsResume.blob('r').put('b', bytes('new content'))
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])
    const atTier = await docsResume.blob('r').atTier()
    expect(await atTier.get('a')).toEqual(original)
    expect(await atTier.get('b')).toEqual(bytes('new content'))

    dbResume.close()
  })
})

// ─── #746 whole-branch review: K=8 stamp-ring blocker ────────────────────
//
// `BlobObject.lastOps` is a BOUNDED ring (K=8). Rehome's destination `+1`s
// are ROW-SCOPED (`${opId}:${slotName}` / `${opId}:${versionKey}`, one
// stamp PER CONTRIBUTING ROW) — a stuck row's OWN stamp can be evicted by
// ≥8 OTHER rows' stamps landing on the SAME destination before that row's
// resume runs, causing a naive ring-only resume to double-apply its `+1`.
// `BlobIntent.appliedStamps` (this op's own unbounded, marker-backed log,
// consulted BEFORE the ring) is the fix — see `applyStampedIncrement`.

describe('#746 whole-branch review — CONCURRENT rehomes converging on one destination (the confirmed over-count)', () => {
  it('8 unrelated records dedup-converge on one destination while a 9th is stuck mid-move → resume does not double-count the stuck row', async () => {
    const store = memory()
    const shared = bytes('concurrent-fanout content')

    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs0.putAtTier('seed', { id: 'seed', title: 'Seed' }, 0)
    await docs0.blob('seed').put('a', shared)
    await docs0.elevate('seed', 1) // creates the tier-1 destination, refCount 1
    await docs0.putAtTier('r1', { id: 'r1', title: 'R1' }, 0)
    await docs0.blob('r1').put('a', shared)
    db0.close()

    // Crash r1's elevate exactly at its OWN slot CAS — its content
    // dedup-hit `+1` lands (stamped `${opId_r1}:a`), but r1's OWN slot
    // pointer update never lands (still not-done from the outer check's
    // perspective, so it WILL be reprocessed on resume).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col, id) => col === SLOTS_COLLECTION && id === 'r1', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    void docsCrash.elevate('r1', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // 8 MORE, entirely unrelated records each fully rehome the SAME shared
    // content in their OWN fresh, successful sessions — each lands its OWN
    // `+1` stamp (a DIFFERENT opId) on the SAME destination, pushing total
    // appends past K=8 (seed + r1 + these 8 = 10) and evicting r1's own
    // stamp from the destination's bounded ring.
    for (let i = 2; i <= 9; i++) {
      const dbI = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
      const vaultI = await dbI.openVault(VAULT)
      const docsI = vaultI.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
      await docsI.putAtTier(`r${i}`, { id: `r${i}`, title: `R${i}` }, 0)
      await docsI.blob(`r${i}`).put('a', shared)
      await docsI.elevate(`r${i}`, 1)
      dbI.close()
    }

    // Resume r1 via an ordinary put() (its own `_tier` already shows 1 —
    // elevate() writes the record before syncBlobs).
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r1').put('unrelated', bytes('trigger resume'))

    // THE regression check: exactly 10 legitimate holders (seed + r1..r9),
    // NOT 11 — pre-fix, r1's evicted stamp went undetected and its `+1`
    // re-applied on resume.
    const atTier = await docsResume.blob('seed').atTier()
    expect((await atTier.blobInfo('a'))!.refCount).toBe(10)
    expect(await store.list(VAULT, '_blob_intent')).toEqual([]) // no dangling markers anywhere

    dbResume.close()
  })
})

describe('#746 whole-branch review — SINGLE-RECORD fan-out (≥9 rows of identical content)', () => {
  it('1 slot + 8 published versions of the same bytes, crash mid-move, resume → refCount is exactly correct, and full demote(→0) crypto-shreds once every holder drops', async () => {
    const store = memory()
    const shared = bytes('single-record fan-out content')

    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs0.putAtTier('r', { id: 'r', title: 'R' }, 0)
    await docs0.blob('r').put('a', shared)
    for (let i = 1; i <= 8; i++) await docs0.blob('r').publish('a', `v${i}`)
    const srcETag = (await docs0.blob('r').blobInfo('a'))!.eTag
    expect((await docs0.blob('r').blobInfo('a'))!.refCount).toBe(9) // 1 slot + 8 versions
    db0.close()

    // Crash exactly before the LAST version's (v8) own metadata write — its
    // destination `+1` (the 9th distinct row-stamp on this destination)
    // has already landed, evicting the SLOT's own (1st, now-stale) stamp
    // from the bounded ring — the exact eviction shape the review flagged,
    // here entirely WITHIN one record's own rehome.
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col, id) => col === VERSIONS_COLLECTION && id === 'r::a::v8', 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    void docsCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise
    expect(await store.list(VAULT, '_blob_intent')).toHaveLength(1)

    // Resume via an ordinary put() (record's `_tier` already shows 1).
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docsResume.blob('r').put('unrelated', bytes('trigger resume'))
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    // THE regression check: exactly 9, NOT doubled.
    const atTier = await docsResume.blob('r').atTier()
    const destInfo = (await atTier.blobInfo('a'))!
    expect(destInfo.refCount).toBe(9)
    expect(destInfo.eTag).not.toBe(srcETag) // genuinely rehomed (isolate policy, tier-1-native eTag)

    // Full demote back to tier 0 releases every hold this record ever
    // established at tier 1; the object must be released down to nothing
    // stranded (proves no over-count survived to permanently inflate the
    // refCount past a real holder count — a doubled +1 here would leave a
    // ghost reference that keeps the tier-1 object alive forever).
    await docsResume.demote('r', 0)
    for (let i = 1; i <= 8; i++) await docsResume.blob('r').deleteVersion('a', `v${i}`)
    await docsResume.blob('r').delete('a')
    const destInternals = docsResume.blob('r') as unknown as BlobSetInternals
    expect(await destInternals.loadBlobObject(destInfo.eTag, 1)).toBeNull() // crypto-shredded, no strand

    dbResume.close()
  })
})

// ─── #746 whole-branch review Hardening 1: no marker for a blob-less move ─

describe('#746 whole-branch review Hardening 1 — syncTierMove skips the marker for a blob-less record', () => {
  it('elevate() on a record with no slots and no published versions mints no `_blob_intent` row', async () => {
    const store = memory()
    const db = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.putAtTier('bare', { id: 'bare', title: 'Bare' }, 0) // no blob ever attached

    await docs.elevate('bare', 1)

    expect(await store.list(VAULT, '_blob_intent')).toEqual([])
    expect(await store.list(VAULT, SLOTS_COLLECTION)).toEqual([]) // nothing minted a slot row either

    db.close()
  })
})

// ─── #746 whole-branch review Hardening 2: shred after rehome uses the RIGHT tier ─

describe('#746 whole-branch review Hardening 2 — post-resume shred mint uses the resumed rehome\'s own toTier', () => {
  it('shredAllForRecord(staleTier) after resuming a pending rehome collects holds at the rehome\'s toTier, not the caller\'s stale argument', async () => {
    const store = memory()
    const db0 = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault0 = await db0.openVault(VAULT)
    const docs0 = vault0.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs0.putAtTier('r', { id: 'r', title: 'R' }, 0)
    await docs0.blob('r').put('a', bytes('elevated content'))
    db0.close()

    // Strand a REHOME marker (fromTier 0 → toTier 1).
    let reached!: () => void
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const crashing = hangOnNthPut(store, (col) => col === SLOTS_COLLECTION, 1, () => reached())
    const dbCrash = await createNoydb({ store: crashing, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultCrash = await dbCrash.openVault(VAULT)
    const docsCrash = vaultCrash.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    void docsCrash.elevate('r', 1) // fire-and-forget: never settles (simulated crash)
    await reachedPromise

    // A DIRECT `shredAllForRecord` caller passing a STALE tier (0 — the
    // record's PRE-rehome tier, as if the caller read the tier before the
    // crash and never learned about the completed rehome). If the fresh
    // shred mint used this stale `0` instead of the resumed rehome's own
    // `toTier` (1), `collectShredHolds(0)` would try the slot map's OLD
    // (now-gone, re-keyed-to-1) tier-0 DEK and either throw or silently
    // see an empty/wrong slot map — the exact hazard Hardening 2 closes.
    const dbResume = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vaultResume = await dbResume.openVault(VAULT)
    const docsResume = vaultResume.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const result = await docsResume.blob('r').shredAllForRecord(0) // stale — the record actually resumed to tier 1

    expect(result.shredded).toHaveLength(1) // found and shredded the tier-1 content — not silently empty
    expect(result.residue).toEqual([])
    expect(await store.list(VAULT, '_blob_intent')).toEqual([])

    dbResume.close()
  })
})
