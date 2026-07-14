/**
 * Satellite per-record-CEK migration (#599) — the R-S7 retro-coverage
 * unblock.
 *
 * Spec: `.superpowers/sdd/m22-seam-map.md` § #599, `.superpowers/sdd/m22-task-4-report.md`.
 *
 * The scenario: app v1 declares `msgs_text satelliteOf msgs` WITHOUT
 * `perRecordKeys` and writes records under the shared collection DEK. App
 * v2 adds `withForgetCascade({ subjects: { msgs: 'from' } })` — the base
 * is now forget-covered, so R-S7 (`declare.ts:89-91`) correctly refuses
 * re-declaring `msgs_text` without `perRecordKeys: true`. Before this
 * migration existed there was no way past that refusal: `perRecordKeys`
 * is construction-only and the only per-record re-encrypt primitive
 * (`_applyCutoverTransform`) was wired only to the generic schema-update
 * cutover, which itself needs the collection already constructed in the
 * target mode — chicken-and-egg.
 *
 * `vault.migrateSatellitePerRecordKeys(name)` breaks the cycle: it opens
 * the satellite collection WITHOUT `satelliteOf` (so `declareSatellite`'s
 * R-S7 gate — which only fires on the `satelliteOf` declaration path — is
 * never entered) forcing `perRecordKeys: true`, then re-encrypts every
 * existing record under a fresh per-record CEK via
 * `Collection._applyCutoverTransform`. The declaration gate itself
 * (`declare.ts`) is untouched — R-S7 still refuses every NORMAL declare
 * exactly as before.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { memory } from '../../to-memory/src/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

const SECRET = 'satellites-cek-migration-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: string
}

/** Wraps a real `to-memory` store with put-failure injection (mirrors satellites-forget.test.ts's spyStore). */
function spyStore(raw: NoydbStore): {
  store: NoydbStore
  failNextPutFor: (coll: string) => void
  failOnNthPutFor: (coll: string, n: number) => void
} {
  let failNextFor: string | null = null
  let nthTarget: { coll: string; n: number } | null = null
  const counts = new Map<string, number>()
  const store: NoydbStore = {
    ...raw,
    async put(vault, coll, id, env, expectedVersion) {
      if (failNextFor === coll) {
        failNextFor = null
        throw new Error(`spy: injected failure for put("${coll}")`)
      }
      if (nthTarget && nthTarget.coll === coll) {
        const c = (counts.get(coll) ?? 0) + 1
        counts.set(coll, c)
        if (c === nthTarget.n) {
          nthTarget = null
          throw new Error(`spy: injected failure on record #${c} for put("${coll}")`)
        }
      }
      return raw.put(vault, coll, id, env, expectedVersion)
    },
  }
  return {
    store,
    failNextPutFor: (coll: string) => { failNextFor = coll },
    failOnNthPutFor: (coll: string, n: number) => { nthTarget = { coll, n }; counts.set(coll, 0) },
  }
}

/** App v1: declares the pair without perRecordKeys and writes records under the shared DEK. */
async function declareV1(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'alice', secret: SECRET })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', {})
  vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
  return vault
}

/** App v2: re-opens with forget coverage newly added on `msgs` — the retro-coverage scenario. */
async function reopenV2(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'alice', secret: SECRET,
    forgetStrategy: withForgetCascade({ subjects: { msgs: 'from' } }),
  })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs', { perRecordKeys: true })
  return vault
}

describe('satellite per-record-CEK migration (#599)', () => {
  it('R-S7 pre-state: retro-coverage refuses the satellite redeclare with no way forward', async () => {
    const rawStore = memory()
    const vault1 = await declareV1(rawStore)
    await vault1.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'B' })

    const vault2 = await reopenV2(rawStore)
    expect(() => vault2.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full',
    })).toThrowError(/R-S7/)
  })

  it('migrates every prior satellite record onto a distinct per-record CEK, then declares cleanly', async () => {
    const rawStore = memory()
    const vault1 = await declareV1(rawStore)
    await vault1.joined('msgs_full').put('x', { from: 'alice@x', subject: 's1', body: 'B1' })
    await vault1.joined('msgs_full').put('y', { from: 'alice@x', subject: 's2', body: 'B2' })

    const vault2 = await reopenV2(rawStore)
    // pre-migration: legacy shared-DEK records, no _cek yet.
    expect((await rawStore.get('v1', 'msgs_text', 'x'))?._cek).toBeUndefined()
    expect((await rawStore.get('v1', 'msgs_text', 'y'))?._cek).toBeUndefined()

    const result = await vault2.migrateSatellitePerRecordKeys('msgs_text')
    expect(result.migrated).toBe(2)

    const envX = await rawStore.get('v1', 'msgs_text', 'x')
    const envY = await rawStore.get('v1', 'msgs_text', 'y')
    expect(envX?._cek).toBeDefined()
    expect(envY?._cek).toBeDefined()
    // Distinct per-record CEKs, not a shared DEK — AES-KW is deterministic
    // over (key, kek), so a differing wrapped `_cek` string proves a
    // differing underlying CEK (per-record-cek.test.ts establishes the
    // converse: an update that reuses the SAME CEK produces an IDENTICAL
    // wrapped string).
    expect(envX?._cek).not.toBe(envY?._cek)

    // R-S7 now satisfied — the normal declare no longer refuses.
    expect(() => vault2.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: true,
    })).not.toThrow()

    // Zero-knowledge sanity: the migrated satellite still round-trips through
    // the normal joined read path (no corruption, no plaintext leak to the
    // assertion above beyond the ciphertext-shape checks).
    expect(await vault2.joined<Msg>('msgs_full').get('x')).toMatchObject({ subject: 's1', body: 'B1' })
    expect(await vault2.joined<Msg>('msgs_full').get('y')).toMatchObject({ subject: 's2', body: 'B2' })
  })

  it('R-S7 still refuses a normal declare that never ran the migration (gate unaffected)', async () => {
    const rawStore = memory()
    const vault1 = await declareV1(rawStore)
    await vault1.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'B' })

    const vault2 = await reopenV2(rawStore)
    // No migration call here — the gate must still refuse.
    expect(() => vault2.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: false,
    })).toThrowError(/R-S7/)
  })

  it('resumability: an interrupted migration resumes to completion without re-minting an already-migrated CEK', async () => {
    const rawStore = memory()
    const { store, failOnNthPutFor } = spyStore(rawStore)
    const vault1 = await declareV1(store)
    await vault1.joined('msgs_full').put('a', { from: 'alice@x', subject: 's', body: 'B' })
    await vault1.joined('msgs_full').put('b', { from: 'alice@x', subject: 's', body: 'B' })
    await vault1.joined('msgs_full').put('c', { from: 'alice@x', subject: 's', body: 'B' })

    const db2 = await createNoydb({
      store, user: 'alice', secret: SECRET,
      forgetStrategy: withForgetCascade({ subjects: { msgs: 'from' } }),
    })
    const vault2 = await db2.openVault('v1')
    vault2.collection<Msg>('msgs', { perRecordKeys: true })

    // Fail the SECOND record's write mid-migration — one record lands
    // (mints a CEK), then the loop throws before the remaining two.
    failOnNthPutFor('msgs_text', 2)
    await expect(vault2.migrateSatellitePerRecordKeys('msgs_text')).rejects.toThrow()

    const before = new Map<string, string | undefined>()
    for (const id of ['a', 'b', 'c']) before.set(id, (await rawStore.get('v1', 'msgs_text', id))?._cek)
    const migratedBeforeResume = [...before.values()].filter((v) => v !== undefined)
    expect(migratedBeforeResume.length).toBe(1) // exactly one record landed before the injected failure

    // Resume — no further injected failures.
    const result = await vault2.migrateSatellitePerRecordKeys('msgs_text')
    expect(result.migrated).toBe(3)

    const after = new Map<string, string | undefined>()
    for (const id of ['a', 'b', 'c']) after.set(id, (await rawStore.get('v1', 'msgs_text', id))?._cek)

    // Every record now carries a CEK.
    for (const id of ['a', 'b', 'c']) expect(after.get(id)).toBeDefined()
    // Pairwise distinct.
    expect(after.get('a')).not.toBe(after.get('b'))
    expect(after.get('b')).not.toBe(after.get('c'))
    expect(after.get('a')).not.toBe(after.get('c'))
    // Idempotence: the record that already had a CEK before the resume
    // keeps the EXACT SAME wrapped CEK — proof it was reused, not re-minted
    // (a second mint would produce a different wrapped string).
    for (const id of ['a', 'b', 'c']) {
      if (before.get(id) !== undefined) expect(after.get(id)).toBe(before.get(id))
    }

    // Not corrupted — redeclare the pair (R-S7 now satisfied) and confirm
    // every record still decrypts correctly through the normal joined path.
    vault2.collection<Msg>('msgs_text', {
      satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full', perRecordKeys: true,
    })
    expect(await vault2.joined<Msg>('msgs_full').get('a')).toMatchObject({ subject: 's', body: 'B' })
    expect(await vault2.joined<Msg>('msgs_full').get('b')).toMatchObject({ subject: 's', body: 'B' })
    expect(await vault2.joined<Msg>('msgs_full').get('c')).toMatchObject({ subject: 's', body: 'B' })
  })
})
