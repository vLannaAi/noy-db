/**
 * Tests for @noy-db/to-probe.
 *
 * Covers:
 *   - runStoreProbe against to-memory: all five axes produce numbers
 *   - Suitability: memory (casAtomic:true) → recommended for all roles
 *   - CAS mismatch: a broken-CAS store declared as atomic emits `cas-mismatch` error risk
 *   - probeTopology: sync-peer with bundle-like name emits warn
 *   - probeTopology: archive with hasPullPolicy emits error
 *   - recommended=false when any error-severity risk surfaces
 *
 * All probes run against in-memory fakes — no I/O, no real backends.
 */
import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, StoreCapabilities } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { runStoreProbe, probeTopology } from '../src/index.js'

/** Minimal in-memory NoydbStore (self-contained so the probe package
 *  doesn't pull @noy-db/to-memory as a dev dep). */
function memoryStore(name = 'memory'): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name,
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) {
        throw new ConflictError(ex._v, `expected ${ev}, found ${ex._v}`)
      }
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, d) {
      for (const [cn, recs] of Object.entries(d)) {
        const coll = getColl(v, cn)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
    async ping() { return true },
  }
}

/** A broken-CAS memory store: ignores `expectedVersion`, always writes.
 *  Simulates a store that advertises casAtomic:true but doesn't enforce it. */
function brokenCasStore(name = 'broken'): NoydbStore {
  const base = memoryStore(name)
  return {
    ...base,
    async put(v, c, id, env /* , _ev */) {
      // Deliberately ignore expectedVersion — every put wins
      await base.put(v, c, id, env)
    },
  }
}

const ATOMIC_CAPS: StoreCapabilities = {
  casAtomic: true,
  auth: { kind: 'none', required: false, flow: 'static' },
}
const NON_ATOMIC_CAPS: StoreCapabilities = {
  casAtomic: false,
  auth: { kind: 'none', required: false, flow: 'static' },
}

describe('runStoreProbe — all five axes against in-memory store', () => {
  it('measures write, cas, hydration, sync, network', async () => {
    const store = memoryStore()
    const report = await runStoreProbe(store, {
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 10,
      hydrationRecords: 50,
      syncBatchSize: 20,
    })

    // D1 — write
    expect(report.write.serial.count).toBe(10)
    expect(report.write.serial.p50).toBeGreaterThanOrEqual(0)
    expect(report.write.serial.p99).toBeGreaterThanOrEqual(report.write.serial.p50)
    expect(report.write.concurrent.count).toBe(5)

    // D2 — cas: exactly one success for an atomic-cas store
    expect(report.cas.concurrent).toBe(10)
    expect(report.cas.successes).toBe(1)
    expect(report.cas.rejections).toBe(9)
    expect(report.cas.expected).toBe('exactly-one')

    // D3 — hydration
    expect(report.hydration.records).toBeGreaterThanOrEqual(50)
    expect(report.hydration.totalBytes).toBeGreaterThan(0)
    expect(report.hydration.perRecordBytes).toBeGreaterThan(0)

    // D4 — sync
    expect(report.sync.batchSize).toBe(20)
    expect(report.sync.bytesPerPush).toBeGreaterThan(0)

    // D5 — network
    expect(report.network.pingSupported).toBe(true)
    expect(report.network.pingMs).toBeGreaterThanOrEqual(0)

    // Metadata
    expect(report.store).toBe('memory')
    expect(report.capabilities).toEqual(ATOMIC_CAPS)
    expect(report.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(report.durationMs).toBeGreaterThan(0)
  })

  it('in-memory store is recommended for all roles', async () => {
    const report = await runStoreProbe(memoryStore(), {
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    expect(report.suitability.recommended).toContain('primary')
    expect(report.suitability.recommended).toContain('sync-peer')
    expect(report.suitability.recommended).toContain('backup')
    expect(report.suitability.recommended).toContain('archive')
    // No error-severity risks
    expect(report.suitability.risks.filter(r => r.severity === 'error')).toHaveLength(0)
  })
})

describe('runStoreProbe — cas-mismatch detection', () => {
  it('raises `cas-mismatch` error when declared casAtomic is violated', async () => {
    const report = await runStoreProbe(brokenCasStore(), {
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    expect(report.cas.successes).toBeGreaterThan(1)
    const casRisk = report.suitability.risks.find(r => r.code === 'cas-mismatch')
    expect(casRisk).toBeDefined()
    expect(casRisk?.severity).toBe('error')
    // Not recommended as primary (error-severity risk disqualifies all roles)
    expect(report.suitability.recommended).toHaveLength(0)
  })

  it('raises `cas-unsupported` warn for casAtomic:false stores', async () => {
    const report = await runStoreProbe(memoryStore(), {
      capabilities: NON_ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    const risk = report.suitability.risks.find(r => r.code === 'cas-unsupported')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('warn')
    // Warn-only — primary still ok, sync-peer excluded
    expect(report.suitability.recommended).toContain('primary')
    expect(report.suitability.recommended).not.toContain('sync-peer')
  })
})

describe('probeTopology — cross-store rules', () => {
  it('flags bundle-shaped sync-peer as warn', async () => {
    const report = await probeTopology({
      store: memoryStore('primary'),
      sync: [{ store: memoryStore('drive-bundle'), role: 'sync-peer', label: 'drive-bundle' }],
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    const risk = report.topology.find(r => r.code === 'bundle-as-sync-peer')
    expect(risk).toBeDefined()
    expect(risk?.target).toBe('drive-bundle')
    expect(risk?.severity).toBe('warn')
  })

  it('flags archive with pull policy as error', async () => {
    const report = await probeTopology({
      store: memoryStore('primary'),
      sync: [
        { store: memoryStore('s3'), role: 'archive', label: 's3', hasPullPolicy: true },
      ],
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    const risk = report.topology.find(r => r.code === 'archive-pull-configured')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('error')
    expect(report.recommended).toBe(false)
  })

  it('recommended=true with a clean single-peer topology', async () => {
    const report = await probeTopology({
      store: memoryStore('primary'),
      sync: [{ store: memoryStore('remote'), role: 'sync-peer', label: 'remote' }],
      capabilities: ATOMIC_CAPS,
      writeSampleSize: 5,
      hydrationRecords: 10,
      syncBatchSize: 10,
    })

    expect(report.recommended).toBe(true)
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.label).toBe('remote')
  })
})
