import { describe, it, expect } from 'vitest'
import type { NoydbMesh, WriterPresence } from '@noy-db/hub/cargo'

/**
 * Poll until `fn` yields something truthy, or the budget runs out. Delivery is
 * asynchronous on every transport — push-based ones deliver on a microtask,
 * `StoreMesh` on its next poll — so no observation here may assume it has
 * already happened.
 *
 * ⚠️ It MUST await the predicate. An earlier version did not, so an `async`
 * predicate returned a Promise, a Promise is always truthy, and every test
 * using one passed without observing anything at all.
 */
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  ms = 3000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const writer = (id: string, lastSeen: number): WriterPresence => ({
  writerId: id, sessionId: `${id}-s`, lastSeen, quiescedAtVersion: null,
})

/**
 * Parameterized conformance suite for the `by-*` family port.
 *
 * `NoydbMesh` is what a session-share transport implements so a schema-fence
 * cutover can drain: who else is live, and what generation are they on.
 *
 * ⚠️ THE FIXTURE IS A PAIR, NOT AN INSTANCE — and that is the whole point.
 * A mesh's defining property is that two participants see each other; a suite
 * built around one instance would pass on an implementation that shares
 * nothing, which is precisely the implementation that breaks a cutover. Same
 * reasoning as the sealer kit requiring a second, differently-identified
 * provider.
 *
 * `channelMesh` (by-peer, by-tabs) is push-based and `StoreMesh` polls,
 * so every observation here is written against `waitFor` rather than assuming
 * synchronous delivery. An implementation that only ever delivers on the next
 * poll is conformant — slow, but conformant.
 */
export function runMeshConformanceTests(
  name: string,
  fixture: {
    /** Two meshes that share coordination state. */
    readonly pair: () => Promise<readonly [NoydbMesh, NoydbMesh]> | readonly [NoydbMesh, NoydbMesh]
    /** Tear down a pair, if the transport needs it. */
    readonly cleanup?: (pair: readonly [NoydbMesh, NoydbMesh]) => void | Promise<void>
  },
): void {
  const VAULT = 'conformance-vault'

  describe(`NoydbMesh conformance: ${name}`, () => {
    const withPair = async (fn: (a: NoydbMesh, b: NoydbMesh) => Promise<void>) => {
      const pair = await fixture.pair()
      try { await fn(pair[0], pair[1]) } finally { await fixture.cleanup?.(pair) }
    }

    it('readFence returns a usable default before anything is written', async () => {
      // A cutover asks the fence before anyone sets one. Throwing here, or
      // returning undefined, breaks the first migration on a fresh vault.
      await withPair(async (a) => {
        const f = await a.readFence(VAULT)
        expect(f).toBeDefined()
        expect(typeof f.currentSchemaVersion).toBe('number')
        expect(['normal', 'draining', 'migrating', 'complete']).toContain(f.fenceState)
      })
    })

    it('setFence → readFence round-trips on the SAME participant', async () => {
      await withPair(async (a) => {
        await a.setFence(VAULT, { currentSchemaVersion: 7, fenceState: 'draining' })
        expect(await a.readFence(VAULT)).toMatchObject({ currentSchemaVersion: 7, fenceState: 'draining' })
      })
    })

    it('setFence on one participant is VISIBLE to the other', async () => {
      // The load-bearing one. A mesh that keeps fence state per-instance
      // passes every single-instance test and still lets a migration proceed
      // while another writer believes the vault is normal.
      await withPair(async (a, b) => {
        await a.setFence(VAULT, { currentSchemaVersion: 9, fenceState: 'migrating' })
        const f = await waitFor(async () => {
          const cur = await b.readFence(VAULT)
          return cur.fenceState === 'migrating' ? cur : null
        })
        expect(f.currentSchemaVersion).toBe(9)
      })
    })

    it('observeFence fires on the other participant when the fence moves', async () => {
      await withPair(async (a, b) => {
        const seen: string[] = []
        const un = b.observeFence(VAULT, (f) => { seen.push(f.fenceState) })
        await a.setFence(VAULT, { currentSchemaVersion: 3, fenceState: 'draining' })
        await waitFor(() => seen.includes('draining'))
        un()
      })
    })

    it('observeFence stops delivering after unsubscribe', async () => {
      await withPair(async (a, b) => {
        const seen: string[] = []
        const un = b.observeFence(VAULT, (f) => { seen.push(f.fenceState) })
        await a.setFence(VAULT, { currentSchemaVersion: 1, fenceState: 'draining' })
        await waitFor(() => seen.includes('draining'))
        un()
        const after = seen.length
        await a.setFence(VAULT, { currentSchemaVersion: 2, fenceState: 'complete' })
        await new Promise((r) => setTimeout(r, 200))
        expect(seen.length, 'callback fired after unsubscribe').toBe(after)
      })
    })

    it('reportPresence on one participant is REACHABLE from the other', async () => {
      await withPair(async (a, b) => {
        const now = Date.now()
        await a.reportPresence(VAULT, writer('w-a', now))
        const found = await waitFor(async () => {
          const ws = await b.reachableWriters(VAULT, { staleMs: 60_000, now: Date.now() })
          return ws.some((w) => w.writerId === 'w-a') ? ws : null
        }, 3000)
        expect(found.map((w) => w.writerId)).toContain('w-a')
      })
    })

    it('reachableWriters EXCLUDES a writer older than staleMs', async () => {
      // The drain barrier waits for reachable writers to quiesce. Counting a
      // dead writer as reachable hangs the cutover until the timeout — the
      // failure this filter exists to prevent.
      await withPair(async (a, b) => {
        const now = Date.now()
        await a.reportPresence(VAULT, writer('w-stale', now - 120_000))
        await new Promise((r) => setTimeout(r, 100))
        const ws = await b.reachableWriters(VAULT, { staleMs: 30_000, now })
        expect(ws.map((w) => w.writerId)).not.toContain('w-stale')
      })
    })

    it('observePresence fires on the other participant', async () => {
      await withPair(async (a, b) => {
        let seen: readonly WriterPresence[] = []
        const un = b.observePresence(VAULT, (ws) => { seen = ws })
        await a.reportPresence(VAULT, writer('w-obs', Date.now()))
        await waitFor(() => seen.some((w) => w.writerId === 'w-obs'))
        un()
      })
    })

    it('keeps vaults isolated — presence in one is not reachable from another', async () => {
      await withPair(async (a, b) => {
        await a.reportPresence(VAULT, writer('w-iso', Date.now()))
        await new Promise((r) => setTimeout(r, 150))
        const other = await b.reachableWriters('a-different-vault', { staleMs: 60_000, now: Date.now() })
        expect(other.map((w) => w.writerId)).not.toContain('w-iso')
      })
    })
  })
}
