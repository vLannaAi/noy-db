/**
 * Variable-N derivations — `shape: 'array'` (#200 slice 1).
 *
 * Covers the contract documented in
 * design-history/2026-05-23-variable-n-derivations.md.
 */
import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withDerivation,
  DerivationCapExceededError,
  DerivationOutputShapeError,
  ValidationError,
} from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  } as unknown as NoydbStore
}

interface Worker extends Record<string, unknown> {
  id: string
  clientId: string
  employmentPeriods: ReadonlyArray<{ from: string; to: string }>
  baseSalary: number
}

interface ActivePeriod extends Record<string, unknown> {
  id: string
  workerId: string
  clientId: string
  period: string  // 'YYYY-MM'
  baseSalary: number
}

/** Lightweight month-overlap helper: returns YYYY-MM strings for months overlapping any period. */
function monthsCovered(periods: ReadonlyArray<{ from: string; to: string }>): string[] {
  const months = new Set<string>()
  for (const p of periods) {
    const start = new Date(`${p.from}-01T00:00:00Z`)
    const end = new Date(`${p.to}-01T00:00:00Z`)
    let cursor = new Date(start)
    while (cursor <= end) {
      const ym = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
      months.add(ym)
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  }
  return [...months].sort()
}

async function buildDb() {
  const strategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
    source: 'workers',
    deterministic: true,
    outputs: {
      activeInPeriod: {
        shape: 'array',
        collection: 'workerActiveInPeriod',
        key: (o) => `${o.workerId as string}|${o.period as string}`,
        maxFanout: 36,
      },
    },
    derive: (worker) => ({
      activeInPeriod: monthsCovered(worker.employmentPeriods).map(period => ({
        id: `${worker.id}|${period}`,
        workerId: worker.id,
        clientId: worker.clientId,
        period,
        baseSalary: worker.baseSalary,
      })),
    }),
    lifecycle: 'eager',
  })

  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'correct horse battery staple printer toaster',
    derivationStrategies: [strategy],
  })
  const vault = await db.openVault('acme')
  return { db, vault }
}

describe('shape: array — basic fanout (#200)', () => {
  it('one source row → N derived rows; all readable', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    // Two-month employment → two derived rows.
    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-04' }],
    })

    const march = await activePeriods.get('w1|2026-03')
    const april = await activePeriods.get('w1|2026-04')
    expect(march).toBeDefined()
    expect(april).toBeDefined()
    expect(march?.workerId).toBe('w1')
    expect(march?.period).toBe('2026-03')
    expect(april?.period).toBe('2026-04')
  })

  it('source update SHRINKS fanout — removed keys are deleted', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-04' }],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeDefined()
    expect(await activePeriods.get('w1|2026-04')).toBeDefined()

    // Update: only March now.
    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-03' }],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeDefined()
    expect(await activePeriods.get('w1|2026-04')).toBeNull()
  })

  it('source update GROWS fanout — new keys are inserted', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-03' }],
    })
    expect(await activePeriods.get('w1|2026-04')).toBeNull()

    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-05' }],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeDefined()
    expect(await activePeriods.get('w1|2026-04')).toBeDefined()
    expect(await activePeriods.get('w1|2026-05')).toBeDefined()
  })

  it('source DELETE cascades — all derived rows go, sidecar deleted', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-05' }],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeDefined()

    await workers.delete('w1')

    expect(await activePeriods.get('w1|2026-03')).toBeNull()
    expect(await activePeriods.get('w1|2026-04')).toBeNull()
    expect(await activePeriods.get('w1|2026-05')).toBeNull()
  })

  it('empty array from derive() clears all prior emissions for that source', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-04' }],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeDefined()

    // Empty array — no employment periods → no active periods.
    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [],
    })
    expect(await activePeriods.get('w1|2026-03')).toBeNull()
    expect(await activePeriods.get('w1|2026-04')).toBeNull()
  })
})

describe('shape: array — validation', () => {
  it('rejects lifecycle "lazy" + shape "array"', () => {
    expect(() => withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        activeInPeriod: {
          shape: 'array',
          collection: 'workerActiveInPeriod',
          key: (o) => String(o.id),
        },
      },
      derive: () => ({ activeInPeriod: [] }),
      lifecycle: 'lazy',
    })).toThrow(/array.*lazy|lifecycle.*'eager'/)
  })

  it('rejects array output without a key extractor', () => {
    expect(() => withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeInPeriod: { shape: 'array', collection: 'wxp' } as any,
      },
      derive: () => ({ activeInPeriod: [] }),
      lifecycle: 'eager',
    })).toThrow(/key.*extractor|requires.*key/i)
  })

  it('rejects negative or zero maxFanout', () => {
    expect(() => withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        activeInPeriod: {
          shape: 'array',
          collection: 'wxp',
          key: (o) => String(o.id),
          maxFanout: 0,
        },
      },
      derive: () => ({ activeInPeriod: [] }),
      lifecycle: 'eager',
    })).toThrow(/maxFanout.*positive|positive integer/)
  })
})

describe('shape: array — runtime errors', () => {
  it('throws DerivationCapExceededError when array exceeds maxFanout', async () => {
    const strategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        activeInPeriod: {
          shape: 'array',
          collection: 'workerActiveInPeriod',
          key: (o) => `${o.workerId as string}|${o.period as string}`,
          maxFanout: 3,
        },
      },
      derive: (worker) => ({
        activeInPeriod: monthsCovered(worker.employmentPeriods).map(period => ({
          id: `${worker.id}|${period}`,
          workerId: worker.id,
          clientId: worker.clientId,
          period,
          baseSalary: worker.baseSalary,
        })),
      }),
      lifecycle: 'eager',
      strict: true,  // surface the error instead of warn-and-continue
    })

    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      derivationStrategies: [strategy],
    })
    const vault = await db.openVault('acme')

    // Force fanout > 3.
    await expect(
      vault.collection<Worker>('workers').put('w1', {
        id: 'w1', clientId: 'cl-A', baseSalary: 30000,
        employmentPeriods: [{ from: '2026-01', to: '2026-06' }],  // 6 months
      }),
    ).rejects.toThrow(DerivationCapExceededError)
  })

  it('throws DerivationOutputShapeError on duplicate keys', async () => {
    const strategy = withDerivation<Worker, { dup: { id: string; v: number }[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        dup: {
          shape: 'array',
          collection: 'duplicates',
          key: () => 'always-the-same',
        },
      },
      derive: () => ({
        dup: [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
        ],
      }),
      lifecycle: 'eager',
      strict: true,
    })

    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      derivationStrategies: [strategy],
    })
    const vault = await db.openVault('acme')

    await expect(
      vault.collection<Worker>('workers').put('w1', {
        id: 'w1', clientId: 'cl-A', baseSalary: 30000,
        employmentPeriods: [],
      }),
    ).rejects.toThrow(DerivationOutputShapeError)
  })

  it('throws DerivationOutputShapeError when non-array returned for array-shape output', async () => {
    const strategy = withDerivation<Worker, { bogus: { id: string } }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        bogus: {
          shape: 'array',
          collection: 'bogus',
          key: (o) => o.id as string,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      derive: () => ({ bogus: { id: 'oops' } as any }),
      lifecycle: 'eager',
      strict: true,
    })

    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      derivationStrategies: [strategy],
    })
    const vault = await db.openVault('acme')

    await expect(
      vault.collection<Worker>('workers').put('w1', {
        id: 'w1', clientId: 'cl-A', baseSalary: 30000,
        employmentPeriods: [],
      }),
    ).rejects.toThrow(DerivationOutputShapeError)
  })
})

describe('shape: array — niwat canonical (interval-overlap MV)', () => {
  it('multi-worker × multi-month fan-out feeds a downstream grouping query', async () => {
    const { vault } = await buildDb()
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    // Three workers, varying periods.
    await workers.put('w1', {
      id: 'w1', clientId: 'cl-A', baseSalary: 30000,
      employmentPeriods: [{ from: '2026-03', to: '2026-03' }],
    })
    await workers.put('w2', {
      id: 'w2', clientId: 'cl-A', baseSalary: 40000,
      employmentPeriods: [{ from: '2026-03', to: '2026-04' }],
    })
    await workers.put('w3', {
      id: 'w3', clientId: 'cl-B', baseSalary: 35000,
      employmentPeriods: [{ from: '2026-03', to: '2026-03' }],
    })

    // List all active-period rows; verify all six (1+2+1=4 actually) rows exist.
    const all = await activePeriods.list()
    // w1: March (1), w2: March+April (2), w3: March (1) = 4 derived rows.
    expect(all.length).toBe(4)

    // Group by (clientId, period) and sum baseSalary for cl-A in March:
    // w1 (30K) + w2 (40K) = 70K
    const marchA = all.filter(r => r.clientId === 'cl-A' && r.period === '2026-03')
    const total = marchA.reduce((s, r) => s + r.baseSalary, 0)
    expect(total).toBe(70000)
  })
})
