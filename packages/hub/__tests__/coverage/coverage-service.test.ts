/**
 * `withCoverage()` end to end, through a real vault (#1363).
 *
 * ⛔⛔ Telemetry, not a control. Against an insider holding the device and
 * local keys this prevents nothing — it makes bulk extraction visible early,
 * attributable and loud. Key custody (tiers, per-collection DEKs) is the
 * remediation.
 *
 * ⚠️ Every bulk-declared collection here is `prefetch: false`. That is not
 * incidental: an EAGER collection decrypts its whole corpus at hydration, so a
 * decrypt-point sensor would read 100% coverage for anyone who opens the
 * vault. The service refuses to account those, loudly — see
 * `accounting.test.ts` and `#resolveAccounted`.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { memoryStore } from '../../src/kernel/memory-store.js'
import { withCoverage } from '../../src/with-audit/coverage/index.js'
import type { NoydbStore } from '../../src/kernel/types.js'
import type { CoverageEvent } from '../../src/port/with/coverage-strategy.js'

const clientSchema = z.object({ id: z.string(), taxId13: z.string(), fee: z.number() })
const noteSchema = z.object({ id: z.string(), body: z.string() })

const CLIENT_META = { taxId13: { label: 'Tax ID', sensitivity: 'public', bulk: 'sensitive' } } as const

async function open(store: NoydbStore, coverage?: ReturnType<typeof withCoverage>) {
  const db = await createNoydb({
    store,
    user: 'alice',
    secret: 'pw-coverage',
    ...(coverage !== undefined ? { coverageStrategy: coverage } : {}),
  })
  const v = await db.openVault('acme')
  const clients = v.collection('clients', {
    schema: clientSchema,
    prefetch: false,
    cache: { maxRecords: 100 },
    fieldMeta: CLIENT_META,
  })
  const notes = v.collection('notes', {
    schema: noteSchema,
    prefetch: false,
    cache: { maxRecords: 100 },
    fieldMeta: { body: { label: 'Body' } },
  })
  return { db, clients, notes }
}

/** A seeded store, written by a session with no sensor attached. */
async function seeded(): Promise<NoydbStore> {
  const store = memoryStore()
  const { db, clients, notes } = await open(store)
  for (let i = 0; i < 30; i++) await clients.put(`c${i}`, { id: `c${i}`, taxId13: `010555${i}`, fee: 100 + i })
  for (let i = 0; i < 5; i++) await notes.put(`n${i}`, { id: `n${i}`, body: 'hello' })
  await db.close()
  return store
}

describe('withCoverage() through a vault', () => {
  it('accounts record decrypts on a bulk-declared collection and ignores the others', async () => {
    const coverage = withCoverage({ collections: { clients: { corpusSize: 30 } } })
    const { db, clients, notes } = await open(await seeded(), coverage)
    for (let i = 0; i < 10; i++) await clients.get(`c${i}`)
    for (let i = 0; i < 5; i++) await notes.get(`n${i}`)
    const stats = coverage.stats()
    expect(stats.map((s) => s.collection)).toEqual(['clients'])
    const s = stats[0]!
    expect(s.principal).toBe('alice')
    expect(s.vault).toBe('acme')
    expect(s.distinct).toBe(10)
    expect(s.coverage).toBeCloseTo(10 / 30, 5)
    await db.close()
  })

  it('emits coverage:threshold on the event bus as the principal completes the set', async () => {
    const coverage = withCoverage({ collections: { clients: { corpusSize: 30, alertAt: [0.5] } } })
    const events: CoverageEvent[] = []
    const { db, clients } = await open(await seeded(), coverage)
    db.on('coverage:threshold', (e) => { events.push(e) })
    // The read the design is about: the whole list, not one record. In lazy
    // mode that is `scan()` — the export-shaped read `/export` performs.
    const rows: unknown[] = []
    for await (const r of clients.scan({ pageSize: 10 })) rows.push(r)
    expect(rows).toHaveLength(30)                 // ⛔ a SIGNAL — nothing was withheld
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      principal: 'alice', vault: 'acme', collection: 'clients', source: 'hub/coverage',
    })
    expect(events[0]!.coverage).toBeGreaterThanOrEqual(0.5)
    expect(events[0]!.novel).toBeGreaterThan(0)
    await db.close()
  })

  it('is inert when not opted in — no observer, no accounting, no event', async () => {
    const { db, clients } = await open(await seeded())
    const events: CoverageEvent[] = []
    db.on('coverage:threshold', (e) => { events.push(e) })
    const rows: unknown[] = []
    for await (const r of clients.scan({ pageSize: 10 })) rows.push(r)
    expect(rows).toHaveLength(30)
    expect(events).toEqual([])
    await db.close()
  })

  it('carries the coverage horizon across sessions — a process restart must not reset it', async () => {
    const store = await seeded()
    const coverage = withCoverage({ collections: { clients: { corpusSize: 30 } } })

    const first = await open(store, coverage)
    for (let i = 0; i < 10; i++) await first.clients.get(`c${i}`)
    await first.db.close()

    const second = await open(store, coverage)
    for (let i = 10; i < 20; i++) await second.clients.get(`c${i}`)
    await second.db.close()

    // One account for (alice, acme, clients), 20 distinct — not 10.
    expect(coverage.stats()).toHaveLength(1)
    expect(coverage.stats()[0]?.distinct).toBe(20)
  })
})
