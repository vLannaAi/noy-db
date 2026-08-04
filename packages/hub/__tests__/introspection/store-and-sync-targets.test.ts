/**
 * #948 Task 4 — two introspection seams on `Noydb`:
 *  - `db.store` — public accessor for the default store (mirrors the
 *    already-existing internal `_store`).
 *  - `db.listSyncTargets(vault)` — enumerates the sync engines wired for a
 *    vault, surfacing label/role/policy (push/pull mode only — no preset
 *    name; that's not in the data model).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../../src/index.js'
import { withSync } from '../../src/with-sync/index.js'

const SECRET = 'x'.repeat(32)

describe('Noydb.store — public store accessor (#948)', () => {
  it('returns the underlying default store instance', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'a', secret: SECRET })
    expect(db.store).toBe(store)
    db.close()
  })
})

describe('Noydb.listSyncTargets (#948)', () => {
  it('returns the wired sync target with its label/role/policy', async () => {
    const remote = memoryStore()
    const db = await createNoydb({
      store: memoryStore(),
      sync: remote,
      user: 'a',
      secret: SECRET,
      syncStrategy: withSync(),
      syncPolicy: {
        push: { mode: 'on-change' },
        pull: { mode: 'interval', intervalMs: 5_000 },
      },
    })
    await db.openVault('acme')

    const targets = db.listSyncTargets('acme')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      role: 'sync-peer',
      policy: {
        push: { mode: 'on-change' },
        pull: { mode: 'interval' },
      },
    })

    db.close()
  })

  it('returns an empty array for a vault with no sync targets', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'a', secret: SECRET })
    await db.openVault('acme')
    expect(db.listSyncTargets('acme')).toEqual([])
    db.close()
  })
})
