/**
 * Store-backed default {@link CoordinationProvider}.
 *
 * Maps the five coordination-port methods onto today's `_meta/schema-fence`
 * store ops so that, with no `by-*` provider injected, the fence service
 * reproduces its current store-polling behavior byte-for-byte. The `observe*`
 * methods are poll-emit (the legacy {@link FenceWatcher} model); `by-tabs` /
 * `by-peer` override them with real-time push.
 *
 * @module
 */

import type { NoydbStore } from '../../kernel/types.js'
import type { Unsubscribe } from '../../port/with/write-hooks.js'
import { loadFence, saveFence, type FenceDoc } from './fence.js'
import { writeClientDoc, listClientDocs, type ClientDoc } from './client-registry.js'
import type { CoordinationProvider, FenceState, WriterPresence } from '../../port/by/types.js'

/**
 * Default poll cadence for the `observe*` fallbacks (ms). Matches the
 * store-poll granularity the fence-controller uses while waiting for quorum
 * (`delay(50)`); the same value the migration cutover falls back to when no
 * real-time provider is injected.
 */
const DEFAULT_POLL_INTERVAL_MS = 50

/** Map a stored {@link ClientDoc} to the port's {@link WriterPresence}. */
function toPresence(doc: ClientDoc): WriterPresence {
  return {
    writerId: doc.clientId,
    // Legacy docs written without a sessionId (and explicit empty) have no
    // session — fall back to the writerId so every presence is session-addressable.
    sessionId: doc.sessionId && doc.sessionId.length > 0 ? doc.sessionId : doc.clientId,
    lastSeen: doc.lastSeen,
    quiescedAtVersion: doc.quiescedAtVersion,
  }
}

function fenceEqual(a: FenceState, b: FenceState): boolean {
  return a.currentSchemaVersion === b.currentSchemaVersion && a.fenceState === b.fenceState
}

function presenceListEqual(a: readonly WriterPresence[], b: readonly WriterPresence[]): boolean {
  if (a.length !== b.length) return false
  const key = (w: WriterPresence) => `${w.writerId}\u0000${w.sessionId}\u0000${w.lastSeen}\u0000${String(w.quiescedAtVersion)}`
  const bk = new Set(b.map(key))
  return a.every((w) => bk.has(key(w)))
}

export class StoreCoordinationProvider implements CoordinationProvider {
  readonly #store: NoydbStore
  readonly #pollIntervalMs: number

  constructor(store: NoydbStore, opts?: { pollIntervalMs?: number }) {
    this.#store = store
    this.#pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async setFence(vault: string, fence: FenceState): Promise<void> {
    // FenceState is structurally FenceDoc (currentSchemaVersion + fenceState).
    await saveFence(this.#store, vault, fence as FenceDoc)
  }

  async readFence(vault: string): Promise<FenceState> {
    // FenceDoc is structurally FenceState (currentSchemaVersion + fenceState).
    return loadFence(this.#store, vault)
  }

  observeFence(vault: string, onChange: (f: FenceState) => void): Unsubscribe {
    let last: FenceState | null = null
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const fence = await loadFence(this.#store, vault)
        if (last === null || !fenceEqual(last, fence)) {
          last = fence
          onChange(fence)
        }
      } catch {
        /* transient store error — retry next tick */
      } finally {
        busy = false
      }
    }
    void poll() // emit current state once immediately
    const timer = setInterval(() => void poll(), this.#pollIntervalMs)
    unref(timer)
    return () => clearInterval(timer)
  }

  async reportPresence(vault: string, p: WriterPresence): Promise<void> {
    await writeClientDoc(this.#store, vault, p.writerId, {
      lastSeen: p.lastSeen,
      quiescedAtVersion: p.quiescedAtVersion,
      sessionId: p.sessionId,
    })
  }

  observePresence(vault: string, onChange: (writers: readonly WriterPresence[]) => void): Unsubscribe {
    let last: readonly WriterPresence[] | null = null
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const docs = await listClientDocs(this.#store, vault)
        const writers = docs.map(toPresence)
        if (last === null || !presenceListEqual(last, writers)) {
          last = writers
          onChange(writers)
        }
      } catch {
        /* transient store error — retry next tick */
      } finally {
        busy = false
      }
    }
    void poll() // emit current set once immediately
    const timer = setInterval(() => void poll(), this.#pollIntervalMs)
    unref(timer)
    return () => clearInterval(timer)
  }

  async reachableWriters(vault: string, o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]> {
    const docs = await listClientDocs(this.#store, vault)
    return docs.map(toPresence).filter((w) => o.now - w.lastSeen <= o.staleMs)
  }
}

/** Best-effort `unref` so a poll timer never holds the process open (Node only). */
function unref(timer: ReturnType<typeof setInterval>): void {
  const t = timer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}
