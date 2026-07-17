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
  it('a dedup-hit rehome with no opId increments refCount normally and leaves no lastOps stamp', async () => {
    const store = memory()
    const db = await createNoydb({ store, secret: SECRET, user: 'owner', tiersStrategy: withTiers(), blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const shared = bytes('unstamped-path content')

    await docs.putAtTier('seed3', { id: 'seed3', title: 'Seed3' }, 0)
    await docs.blob('seed3').put('attachment', shared)
    await docs.elevate('seed3', 1) // unstamped — today's default path
    const seed3AtTier = await docs.blob('seed3').atTier()
    const destETag = (await seed3AtTier.blobInfo('attachment'))!.eTag

    await docs.putAtTier('u', { id: 'u', title: 'U' }, 0)
    await docs.blob('u').put('attachment', shared)
    await docs.elevate('u', 1) // no opId — this call is what `syncBlobs` still performs today

    const destInternals = docs.blob('seed3') as unknown as BlobSetInternals
    const dest = await destInternals.loadBlobObject(destETag, 1)
    expect(dest!.blob.refCount).toBe(2) // seed3's create + u's dedup-hit — ordinary behavior
    expect(dest!.blob.lastOps ?? []).toEqual([]) // no stamp recorded — zero footprint when opId is omitted

    db.close()
  })
})
