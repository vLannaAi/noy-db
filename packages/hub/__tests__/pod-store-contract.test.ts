/**
 * #908 — `wrapPodStore` is the single choke point through which every
 * pod-shaped backend (`to-drive`, `to-icloud`) enters the six-method store
 * contract, and it failed that contract on two counts.
 *
 * Found by wiring the extended stores into adapter-conformance
 * (noy-db-to#26): both reproduce against any `NoydbPodStore` fake, so neither
 * is store-specific — they belong to the wrapper.
 */
import { describe, it, expect } from 'vitest'
import { wrapPodStore } from '../src/with-pod/pod-store.js'
import { PodVersionConflictError } from '../src/kernel/errors.js'
import type { NoydbPodStore, EncryptedEnvelope } from '../src/index.js'

const env = (v: number, data = 'd'): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: '2026-01-01T00:00:00.000Z', _iv: 'aXY=', _data: data }) as EncryptedEnvelope

/**
 * Minimal in-memory pod with real OCC semantics — a version token that bumps
 * on write and rejects a stale `expectedVersion`, which is what makes the
 * concurrency case meaningful rather than a formality.
 */
function fakePod(): NoydbPodStore & { reads: () => number; writes: () => number } {
  const blobs = new Map<string, { bytes: Uint8Array; version: string }>()
  let seq = 0
  let reads = 0
  let writes = 0
  return {
    name: 'fake-pod',
    async readBundle(vault: string) {
      reads++
      const hit = blobs.get(vault)
      return hit ? { bytes: hit.bytes, version: hit.version } : null
    },
    async writeBundle(vault: string, bytes: Uint8Array, expectedVersion?: string | null) {
      const cur = blobs.get(vault) ?? null
      const curVersion = cur?.version ?? null
      if (expectedVersion !== undefined && expectedVersion !== curVersion) {
        throw new PodVersionConflictError(
          `version mismatch: expected ${expectedVersion}, have ${curVersion}`,
        )
      }
      writes++
      const version = `v${++seq}`
      blobs.set(vault, { bytes, version })
      return { version }
    },
    async deleteBundle(vault: string) { blobs.delete(vault) },
  } as NoydbPodStore & { reads: () => number; writes: () => number }
}

describe('#908 — wrapPodStore.loadAll excludes internal collections', () => {
  it('omits _keyring and _sync from the snapshot', async () => {
    const store = wrapPodStore(fakePod())

    await store.put('acme', 'invoices', 'inv-1', env(1, 'record'))
    await store.put('acme', '_keyring', 'user-01', env(1, 'keyring'))
    await store.put('acme', '_sync', 'meta', env(1, 'sync'))

    const snap = await store.loadAll('acme')

    expect(snap['invoices']).toBeDefined()
    expect(snap['_keyring']).toBeUndefined()
    expect(snap['_sync']).toBeUndefined()
  })

  it('still serves internal collections through get() — only snapshots exclude them', async () => {
    // The filter is about what a *snapshot* claims, not about hiding the data.
    const store = wrapPodStore(fakePod())
    await store.put('acme', '_keyring', 'user-01', env(1, 'keyring'))

    expect(await store.get('acme', '_keyring', 'user-01')).not.toBeNull()
  })

  it('returns a snapshot the caller cannot use to corrupt the wrapper', async () => {
    // loadAll handed out its live internal object, so a caller mutating the
    // result silently rewrote the wrapper's cache.
    const store = wrapPodStore(fakePod())
    await store.put('acme', 'invoices', 'inv-1', env(1))

    const snap = await store.loadAll('acme')
    delete snap['invoices']

    const again = await store.loadAll('acme')
    expect(again['invoices']).toBeDefined()
  })
})

describe('#908 — wrapPodStore serialises concurrent writes', () => {
  it('keeps every record when 100 puts race', async () => {
    // The conformance case "handles rapid sequential writes". Through the
    // wrapper only ONE record survived: every concurrent put called load(),
    // which re-read the bundle and REPLACED the shared snapshot object, so
    // each put mutated an object the next load had already orphaned.
    const store = wrapPodStore(fakePod())

    await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.put('acme', 'invoices', `inv-${i}`, env(1, `r${i}`))),
    )

    const ids = await store.list('acme', 'invoices')
    expect(ids).toHaveLength(100)
  })

  it('keeps records written concurrently across different collections', async () => {
    const store = wrapPodStore(fakePod())

    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => store.put('acme', 'invoices', `i-${i}`, env(1))),
      ...Array.from({ length: 25 }, (_, i) => store.put('acme', 'clients', `c-${i}`, env(1))),
    ])

    expect(await store.list('acme', 'invoices')).toHaveLength(25)
    expect(await store.list('acme', 'clients')).toHaveLength(25)
  })

  it('survives a round-trip: concurrent writes are readable from a FRESH wrapper', async () => {
    // Guards the difference between "the in-memory snapshot has 100" and
    // "100 were actually flushed to the pod".
    const pod = fakePod()
    const store = wrapPodStore(pod)

    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.put('acme', 'invoices', `inv-${i}`, env(1))),
    )

    const reopened = wrapPodStore(pod)
    expect(await reopened.list('acme', 'invoices')).toHaveLength(50)
  })

  it('concurrent deletes and puts do not resurrect or drop unrelated records', async () => {
    const store = wrapPodStore(fakePod())
    for (let i = 0; i < 20; i++) await store.put('acme', 'invoices', `inv-${i}`, env(1))

    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.delete('acme', 'invoices', `inv-${i}`)),
      ...Array.from({ length: 10 }, (_, i) => store.put('acme', 'invoices', `new-${i}`, env(1))),
    ])

    const ids = (await store.list('acme', 'invoices')).sort()
    expect(ids).toHaveLength(20) // 10 survivors + 10 new
    expect(ids).not.toContain('inv-0')
    expect(ids).toContain('inv-19')
    expect(ids).toContain('new-0')
  })
})
