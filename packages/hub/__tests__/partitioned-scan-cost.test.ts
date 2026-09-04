/**
 * The measured win (#1342, ADR 0007) — 1 of 12 partitions vs 12 of 12.
 *
 * ⭐ **THE UNIT IS ENVELOPES DECRYPTED, NOT WALL CLOCK.** `collection.scan()`
 * decrypts every page it fetches, so the thing pruning buys is decryption
 * never paid; wall clock is a consequence of it and varies with the machine.
 * The store here counts envelopes it hands to the decrypt path per
 * collection, so the assertion is about work the design avoids rather than
 * about how fast this laptop ran today. The elapsed times are logged for the
 * PR body and asserted on only in the weak direction.
 *
 * Both arms return the SAME ROWS. That is deliberate and load-bearing: a
 * "faster" arm that returned fewer rows would be measuring the bug this whole
 * module's whitelist exists to prevent, so the row-equality assertion comes
 * first and the cost assertions follow it.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ListPageResult } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { partitioned } from '../src/with-store/partitioned/index.js'

interface Row { id: string; period: string; amount: number }

const PARTITIONS = Array.from({ length: 12 }, (_, i) => `FY2026-P${String(i + 1).padStart(2, '0')}`)
const PER_PARTITION = 250
const TARGET = PARTITIONS[6]!

function toMemory(served: { envelopes: number }): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async listPage(c, col, cursor, limit): Promise<ListPageResult> {
      const coll = store.get(c)?.get(col)
      const ids = coll ? [...coll.keys()].sort() : []
      const start = cursor ? Number.parseInt(cursor, 10) : 0
      const end = Math.min(start + (limit ?? 100), ids.length)
      const items = ids.slice(start, end).map((id) => ({ id, envelope: coll!.get(id)! }))
      served.envelopes += items.length
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
    async loadAll(c) {
      const comp = store.get(c)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        snapshot[n] = r
      }
      return snapshot
    },
    async saveAll() { /* unused */ },
  }
}

describe('partition pruning — measured (#1342)', () => {
  it('1 of 12 partitions decrypts a twelfth of the envelopes, for the same rows', async () => {
    const served = { envelopes: 0 }
    const db = await createNoydb({ store: toMemory(served), user: 'owner', secret: 'measure-2026' })
    const vault = await db.openVault('BENCH')
    const rows = partitioned<Row>(vault, { name: 'ledger', key: 'period', partitions: PARTITIONS })

    let n = 0
    for (const period of PARTITIONS) {
      for (let i = 0; i < PER_PARTITION; i++) {
        n += 1
        await rows.put(`r-${n}`, { id: `r-${n}`, period, amount: i })
      }
    }

    // Arm A — pruned. `period == TARGET` is on the whitelist, so eleven
    // collections are never asked for.
    served.envelopes = 0
    const tA = performance.now()
    const pruned = await rows.scan({ pageSize: 200 }).where('period', '==', TARGET).toArray()
    const msA = performance.now() - tA
    const envA = served.envelopes

    // Arm B — the SAME question asked in a shape the whitelist cannot prove,
    // so every partition is streamed and filtered per record. This is what the
    // feature replaces, and it is also exactly the fallback the whitelist
    // guarantees: the answer is identical, only the cost differs.
    served.envelopes = 0
    const tB = performance.now()
    const unpruned = await rows.scan({ pageSize: 200 }).filter((r) => r.period === TARGET).toArray()
    const msB = performance.now() - tB
    const envB = served.envelopes

    // 1. Same answer. Asserted BEFORE any cost claim.
    expect(pruned).toHaveLength(PER_PARTITION)
    expect(new Set(pruned.map((r) => r.id))).toEqual(new Set(unpruned.map((r) => r.id)))

    // 2. Same envelopes, a twelfth of the decryption.
    expect(envA).toBe(PER_PARTITION)
    expect(envB).toBe(PER_PARTITION * PARTITIONS.length)
    expect(envA * PARTITIONS.length).toBe(envB)

    // 3. Wall clock, in the weak direction only — the strong claim is (2).
    expect(msA).toBeLessThan(msB)

    // eslint-disable-next-line no-console
    console.log(
      `[#1342] ${PARTITIONS.length} partitions x ${PER_PARTITION} records\n` +
      `  pruned   (1 of 12): ${envA} envelopes decrypted, ${msA.toFixed(1)}ms\n` +
      `  unpruned (12 of 12): ${envB} envelopes decrypted, ${msB.toFixed(1)}ms\n` +
      `  ratio: ${(envB / envA).toFixed(1)}x envelopes, ${(msB / msA).toFixed(1)}x time`,
    )
  }, 120_000)
})
