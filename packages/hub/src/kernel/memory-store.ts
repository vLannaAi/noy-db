import type { NoydbStore, VaultSnapshot, EncryptedEnvelope, StoreTime, ListPageResult, TxOp } from './types.js'
import { ConflictError } from './errors.js'

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /**
   * Implement the OPTIONAL half of the store contract — `listVaults`,
   * `ping`, `tx` — and declare `txAtomic`. Off by default: see the note on
   * {@link memoryStore} for why the zero-config store must stay a bare core.
   *
   * Also switches the store clock to monotonic wall-clock milliseconds,
   * which is what makes {@link MemoryStoreOptions.clockUncertaintyMs} an
   * honest unit.
   */
  readonly full?: boolean
  /**
   * Widen the interval `getStoreTime()` returns by ±this many milliseconds,
   * to exercise the commit-wait path in deferred numbering. Default 0 (exact).
   *
   * Requires `full: true` — against the default's counter clock a millisecond
   * epsilon is meaningless, so passing it alone is rejected rather than
   * silently ignored.
   */
  readonly clockUncertaintyMs?: number
}

const MEMORY_STORE_OPTION_KEYS = ['full', 'clockUncertaintyMs'] as const

/**
 * Built-in in-memory store — the kernel's zero-config default.
 *
 * Nested `Map`s: `vault → collection → id → envelope`. Non-persistent
 * (data is lost on process exit). A conformant {@link NoydbStore} with CAS
 * atomicity and a monotonic store clock, so `createNoydb()` works with no
 * store package at all.
 *
 * Portable: imports only `types` + `errors` (no crypto primitive) — passes
 * the `stores-ciphertext-only` architecture guard.
 *
 * ## Why the default is a bare 6-method core
 *
 * Called with no options it implements the 6-method core ONLY, so
 * `Noydb.listAccessibleVaults()` throws its documented capability error
 * rather than enumerating vaults under a store the caller never chose. That
 * omission is a decision, not a gap — do not "complete" it. `full: true` is
 * how a caller opts into the optional half, and
 * `__tests__/memory-store-full.test.ts` guards the default against exactly
 * that well-meaning change.
 */
export function memoryStore(options: MemoryStoreOptions = {}): NoydbStore {
  for (const k of Object.keys(options)) {
    if (!(MEMORY_STORE_OPTION_KEYS as readonly string[]).includes(k)) {
      throw new Error(
        `memoryStore: unknown option \`${k}\`. Known options: ${MEMORY_STORE_OPTION_KEYS.join(', ')}.`,
      )
    }
  }
  const full = options.full === true
  if (options.clockUncertaintyMs !== undefined && !full) {
    throw new Error(
      'memoryStore: `clockUncertaintyMs` requires `full: true` — the default ' +
        'store clock is a counter, not milliseconds, so an ms epsilon around ' +
        'it would be meaningless.',
    )
  }
  const epsilon = options.clockUncertaintyMs ?? 0

  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  let clock = 0

  const coll = (vault: string, collection: string): Map<string, EncryptedEnvelope> => {
    let comp = store.get(vault)
    if (!comp) { comp = new Map(); store.set(vault, comp) }
    let c = comp.get(collection)
    if (!c) { c = new Map(); comp.set(collection, c) }
    return c
  }

  const core: NoydbStore = {
    name: 'memory',
    capabilities: {
      casAtomic: true,
      serverWriteTime: true,
      ...(full ? { txAtomic: true } : {}),
      auth: { kind: 'none', required: false, flow: 'static' },
    },

    async getStoreTime(): Promise<StoreTime> {
      // `full` reports real milliseconds — `Math.max(clock + 1, Date.now())`
      // stays strictly increasing even when two calls land inside the same
      // millisecond, so ordering is exact while the unit stays wall-clock and
      // `clockUncertaintyMs` means what it says (#845). The default keeps the
      // bare counter: nothing reads it as a duration.
      const now = full ? (clock = Math.max(clock + 1, Date.now())) : ++clock
      return { earliest: now - epsilon, latest: now + epsilon }
    },

    async get(vault, collection, id) {
      return store.get(vault)?.get(collection)?.get(id) ?? null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const c = coll(vault, collection)
      const existing = c.get(id)
      if (expectedVersion !== undefined && existing && existing._v !== expectedVersion) {
        throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
      }
      c.set(id, envelope)
    },

    async delete(vault, collection, id) {
      store.get(vault)?.get(collection)?.delete(id)
    },

    async list(vault, collection) {
      const c = store.get(vault)?.get(collection)
      return c ? [...c.keys()] : []
    },

    async loadAll(vault): Promise<VaultSnapshot> {
      const comp = store.get(vault)
      const snapshot: VaultSnapshot = {}
      if (comp) {
        for (const [name, c] of comp) {
          if (name.startsWith('_')) continue // system collections hydrate lazily
          const records: Record<string, EncryptedEnvelope> = {}
          for (const [id, envelope] of c) records[id] = envelope
          snapshot[name] = records
        }
      }
      return snapshot
    },

    async saveAll(vault, data: VaultSnapshot) {
      const comp = store.get(vault)
      if (comp) for (const k of [...comp.keys()]) if (!k.startsWith('_')) comp.delete(k)
      for (const [name, records] of Object.entries(data)) {
        const c = coll(vault, name)
        for (const [id, envelope] of Object.entries(records)) c.set(id, envelope)
      }
    },

    async listPage(vault, collection, cursor, limit = 100): Promise<ListPageResult> {
      const c = store.get(vault)?.get(collection)
      if (!c) return { items: [], nextCursor: null }
      const ids = [...c.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = c.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }

  if (!full) return core

  return {
    ...core,

    async ping() {
      return true
    },

    /**
     * Enumerate every top-level vault held by this store — the outer Map's
     * keys, O(vaults). Intentionally unsorted; sort at the call site if you
     * need a stable order.
     */
    async listVaults() {
      return [...store.keys()]
    },

    /**
     * Multi-record atomic transaction. Validates every op's
     * `expectedVersion` against current state first and throws on the first
     * mismatch with nothing written, then applies every op in one
     * synchronous burst — the Map mutations cannot interleave in the JS
     * event loop, so this is truly atomic.
     */
    async tx(ops: readonly TxOp[]) {
      for (const op of ops) {
        if (op.type === 'put' && !op.envelope) {
          throw new Error(`tx: put op for ${op.id} is missing envelope`)
        }
        if (op.expectedVersion === undefined) continue
        const actual = store.get(op.vault)?.get(op.collection)?.get(op.id)?._v ?? 0
        if (actual !== op.expectedVersion) {
          throw new ConflictError(
            actual,
            `tx: ${op.vault}/${op.collection}/${op.id} expected v${op.expectedVersion}, found v${actual}`,
          )
        }
      }
      for (const op of ops) {
        if (op.type === 'put') {
          coll(op.vault, op.collection).set(op.id, op.envelope!)
        } else {
          store.get(op.vault)?.get(op.collection)?.delete(op.id)
        }
      }
    },
  }
}
