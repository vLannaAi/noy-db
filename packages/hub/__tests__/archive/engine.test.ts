import { describe, it, expect } from 'vitest'
import { runArchive, runRestore, runListArchived, type ArchiveContext, type ArchivePolicy } from '../../src/with-fork/archive/engine.js'
import type { EncryptedEnvelope, NoydbStore } from '../../src/types.js'

// A minimal in-memory store standing in for the cold archive target.
function memStore(): NoydbStore {
  const m = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    async get(v, c, i) { return m.get(k(v, c, i)) ?? null },
    async put(v, c, i, e) { m.set(k(v, c, i), e) },
    async delete(v, c, i) { m.delete(k(v, c, i)) },
    async list(v, c) {
      const p = `${v}/${c}/`
      return [...m.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length))
    },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

const env = (id: string): EncryptedEnvelope => ({ _v: 1, ciphertext: id } as unknown as EncryptedEnvelope)

interface Rec extends Record<string, unknown> { id: string; year: number; hold?: boolean }

/** Build a context over a fake "primary" record set + a real cold store. */
function ctxOver(
  records: Record<string, Rec>,
  policy: ArchivePolicy<Rec>,
  archiveStore = memStore(),
): { ctx: ArchiveContext; primary: Record<string, Rec>; archiveStore: NoydbStore } {
  const primary = { ...records }
  const ctx: ArchiveContext = {
    vaultId: 'v',
    archiveStore,
    collectionsWithPolicy: () => ['recs'],
    getPolicy: (c) => (c === 'recs' ? (policy as ArchivePolicy) : null),
    listRecordIds: async () => Object.keys(primary),
    getRecord: async (_c, id) => primary[id] ?? null,
    getEnvelope: async (_c, id) => (primary[id] ? env(id) : null),
    removeFromPrimary: async (_c, id) => { delete primary[id] },
    restoreToPrimary: async (_c, id) => { primary[id] = { id, year: 0 } },
  }
  return { ctx, primary, archiveStore }
}

describe('runArchive', () => {
  it('relocates eligible records, skips ineligible', async () => {
    const { ctx, primary, archiveStore } = ctxOver(
      { a: { id: 'a', year: 2020 }, b: { id: 'b', year: 2025 } },
      { archiveWhen: (r) => r.year <= 2022 },
    )
    const res = await runArchive(ctx)
    expect(res.archived).toBe(1)
    expect(primary).toEqual({ b: { id: 'b', year: 2025 } }) // a removed from primary
    expect(await archiveStore.list('v', 'recs')).toEqual(['a']) // a in cold store
  })

  it('legalHold blocks archival and is counted as held', async () => {
    const { ctx, primary } = ctxOver(
      { a: { id: 'a', year: 2020, hold: true }, b: { id: 'b', year: 2020 } },
      { archiveWhen: () => true, legalHold: (r) => r.hold === true },
    )
    const res = await runArchive(ctx)
    expect(res.archived).toBe(1) // only b
    expect(res.held).toBe(1)     // a held
    expect(primary.a).toBeDefined()   // a stays in primary
    expect(primary.b).toBeUndefined()
  })

  it('fail-closed: throwing legalHold retains the record', async () => {
    const { ctx, primary } = ctxOver(
      { a: { id: 'a', year: 2020 } },
      { archiveWhen: () => true, legalHold: () => { throw new Error('x') } },
    )
    const res = await runArchive(ctx)
    expect(res.held).toBe(1)
    expect(primary.a).toBeDefined()
  })

  it('dryRun previews without relocating', async () => {
    const { ctx, primary, archiveStore } = ctxOver(
      { a: { id: 'a', year: 2020 } },
      { archiveWhen: () => true },
    )
    const res = await runArchive(ctx, { dryRun: true })
    expect(res.archived).toBe(1)
    expect(primary.a).toBeDefined()                    // not actually removed
    expect(await archiveStore.list('v', 'recs')).toHaveLength(0)
  })

  it('maxArchives caps the batch', async () => {
    const { ctx } = ctxOver(
      { a: { id: 'a', year: 2020 }, b: { id: 'b', year: 2020 }, c: { id: 'c', year: 2020 } },
      { archiveWhen: () => true },
    )
    const res = await runArchive(ctx, { maxArchives: 2 })
    expect(res.archived).toBe(2)
  })
})

describe('runRestore + runListArchived', () => {
  it('restores an archived record back to primary and clears it from cold', async () => {
    const { ctx, primary, archiveStore } = ctxOver(
      { a: { id: 'a', year: 2020 } },
      { archiveWhen: () => true },
    )
    await runArchive(ctx)
    expect(primary.a).toBeUndefined()
    expect(await runListArchived(ctx)).toEqual([{ collection: 'recs', id: 'a' }])

    const ok = await runRestore(ctx, 'recs', 'a')
    expect(ok).toBe(true)
    expect(primary.a).toBeDefined()                         // back in primary
    expect(await archiveStore.list('v', 'recs')).toHaveLength(0) // gone from cold
  })

  it('restore of a non-archived id returns false', async () => {
    const { ctx } = ctxOver({}, { archiveWhen: () => true })
    expect(await runRestore(ctx, 'recs', 'missing')).toBe(false)
  })
})
