#!/usr/bin/env node
/**
 * Bench harness for v0.23 #270 — lazy-mode indexes at 50K records.
 *
 * This is the Node-side skeleton. The acceptance gate (p95 < 250ms on
 * `to-browser-idb`) requires a browser environment via the showcase
 * Playwright infra; that run is a separate follow-up. This script
 * establishes the hub-level baseline: how fast is the query dispatch +
 * decrypt path when the adapter is free (in-memory)?
 *
 * Usage: node packages/hub/scripts/bench-lazy-indexes.mjs [records]
 *
 * Records defaults to 50_000. Smaller values (e.g. 5_000) are useful
 * during local iteration; CI should run the full 50K target.
 *
 * Output: writes a Markdown report fragment to stdout that can be
 * copied into docs/perf/v0.22-index-bench.md for the pilot-2 sign-off.
 */

import { createNoydb } from '../dist/index.js'

const RECORDS = Number(process.argv[2] ?? 50_000)
const RUNS = 100
const SECRET = 'bench-lazy-indexes-2026'

function memory() {
  const store = new Map()
  function col(c, n) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(n); if (!coll) { coll = new Map(); comp.set(n, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, n, id) { return store.get(c)?.get(n)?.get(id) ?? null },
    async put(c, n, id, env) { col(c, n).set(id, env) },
    async delete(c, n, id) { store.get(c)?.get(n)?.delete(id) },
    async list(c, n) { const coll = store.get(c)?.get(n); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s = {}
      if (comp) for (const [k, coll] of comp) if (!k.startsWith('_')) {
        const r = {}; for (const [id, e] of coll) r[id] = e; s[k] = r
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map()
      for (const [n, recs] of Object.entries(data)) {
        const coll = new Map(); for (const [id, env] of Object.entries(recs)) coll.set(id, env)
        comp.set(n, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [n, coll] of existing) if (n.startsWith('_')) comp.set(n, coll)
      store.set(c, comp)
    },
  }
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

async function main() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
  const vault = await db.openVault('BENCH')
  const coll = vault.collection('disbursements', {
    prefetch: false,
    cache: { maxRecords: 1000 },
    indexes: ['clientId', 'period', 'status'],
  })

  process.stdout.write(`seeding ${RECORDS} records… `)
  const seedStart = performance.now()
  const periods = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']
  const statuses = ['draft', 'submitted', 'paid']
  for (let i = 0; i < RECORDS; i++) {
    await coll.put(`d-${String(i).padStart(6, '0')}`, {
      id: `d-${String(i).padStart(6, '0')}`,
      clientId: `c-${String(i % 200).padStart(3, '0')}`,
      period: periods[i % 4],
      status: statuses[i % 3],
      amount: (i * 17) % 100000,
    })
  }
  const seedMs = performance.now() - seedStart
  console.log(`done in ${seedMs.toFixed(0)}ms`)

  // Three representative pilot-2 queries.
  const cases = [
    { name: 'byClient', run: () => coll.lazyQuery().where('clientId', '==', 'c-042').toArray() },
    { name: 'byPeriod', run: () => coll.lazyQuery().where('period', '==', '2026-Q1').toArray() },
    { name: 'byStatusOrdered', run: () => coll.lazyQuery()
        .where('status', '==', 'submitted')
        .orderBy('clientId', 'asc')
        .limit(50)
        .toArray() },
  ]

  console.log()
  console.log('| query | p50 (ms) | p95 (ms) | n rows |')
  console.log('|---|---:|---:|---:|')
  for (const c of cases) {
    const samples = []
    let n = 0
    // Warm-up one run so the persisted-index bulk-load isn't counted.
    n = (await c.run()).length
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now()
      await c.run()
      samples.push(performance.now() - t0)
    }
    console.log(`| ${c.name} | ${pct(samples, 50).toFixed(2)} | ${pct(samples, 95).toFixed(2)} | ${n} |`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
