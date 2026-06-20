/**
 * **@noy-db/by-tabs** real-time {@link CoordinationProvider} — a drain-barrier
 * transport over a {@link PeerChannel} (BroadcastChannel between tabs).
 *
 * The kernel defines the {@link CoordinationProvider} port (#469); the store
 * default polls `_meta/schema-fence`, but a multi-tab app can inject this
 * push-based provider so a schema cutover fences **instantly** instead of via
 * store polling. The migration cutover and `@klum-db/lobby` both drive the same
 * port through `coordinationStrategy`, so neither names `by-tabs`.
 *
 * ## Wire protocol
 *
 * Payloads are JSON strings (the `PeerChannel` is string-only). Every envelope
 * carries a `k` discriminator, namespaced `co-*` so it never collides with a
 * write-relay sharing the same channel:
 *
 * ```jsonc
 * { "k": "co-fence",    "vault": "acme", "fence": { ... } }
 * { "k": "co-presence", "vault": "acme", "presence": { ... } }
 * ```
 *
 * ## Local-echo
 *
 * BroadcastChannel does **not** echo a post back to the sender, so every local
 * op (`setFence`, `reportPresence`) updates this provider's own in-memory state
 * and notifies its own subscribers *before* broadcasting. Remote tabs converge
 * via the `message` listener.
 *
 * @module
 */

import type { PeerChannel } from '@noy-db/by-peer'
import type { CoordinationProvider, FenceState, WriterPresence } from '@noy-db/hub/kernel'

/** Default fence when a vault has never been fenced. */
const DEFAULT_FENCE: FenceState = { currentSchemaVersion: 0, fenceState: 'normal' }

/**
 * Default presence horizon used when pruning before an `observePresence` emit
 * (`reachableWriters` is always given an explicit `staleMs` by the caller). A
 * tab that stops heartbeating for longer than this drops out of pushed batches.
 */
const DEFAULT_STALE_MS = 30_000

type FenceEnvelope = { readonly k: 'co-fence'; readonly vault: string; readonly fence: FenceState }
type PresenceEnvelope = {
  readonly k: 'co-presence'
  readonly vault: string
  readonly presence: WriterPresence
}
type Envelope = FenceEnvelope | PresenceEnvelope

interface VaultState {
  fence: FenceState
  readonly presence: Map<string, WriterPresence>
  readonly fenceObservers: Set<(f: FenceState) => void>
  readonly presenceObservers: Set<(w: readonly WriterPresence[]) => void>
}

/**
 * Build a real-time {@link CoordinationProvider} backed by a {@link PeerChannel}.
 *
 * The provider owns its in-memory fence + presence maps per vault and keeps
 * them in sync with every other tab on the channel. Pass it as
 * `createNoydb({ coordinationStrategy: tabsCoordination(ch) })`, or drive it
 * directly via {@link runDrainBarrier}.
 */
export function tabsCoordination(channel: PeerChannel): CoordinationProvider {
  const vaults = new Map<string, VaultState>()

  function stateFor(vault: string): VaultState {
    let s = vaults.get(vault)
    if (!s) {
      s = {
        fence: DEFAULT_FENCE,
        presence: new Map(),
        fenceObservers: new Set(),
        presenceObservers: new Set(),
      }
      vaults.set(vault, s)
    }
    return s
  }

  function notifyFence(s: VaultState): void {
    for (const cb of [...s.fenceObservers]) cb(s.fence)
  }

  /**
   * Prune a vault's presence map to writers seen within `staleMs` of `now`,
   * deleting stale entries from the canonical map. Callers pass their own
   * authoritative clock — never a wall clock — so a synthetic test clock and a
   * real `Date.now()` heartbeat stay consistent.
   */
  function prune(s: VaultState, now: number, staleMs: number): WriterPresence[] {
    const live: WriterPresence[] = []
    for (const [id, p] of [...s.presence]) {
      if (now - p.lastSeen <= staleMs) live.push(p)
      else s.presence.delete(id)
    }
    return live
  }

  function notifyPresence(s: VaultState): void {
    if (s.presenceObservers.size === 0) return
    // Best-effort prune for the *pushed batch* so a tab that stopped
    // heartbeating drops out, but DON'T mutate the canonical map here: emits
    // happen on the provider's local clock, while `reportPresence` callers may
    // stamp `lastSeen` with a synthetic clock. Authoritative deletion belongs to
    // `reachableWriters`, which is handed the caller's clock + staleMs.
    const newest = Math.max(...[...s.presence.values()].map((p) => p.lastSeen))
    const horizon = newest - DEFAULT_STALE_MS
    const live = [...s.presence.values()].filter((p) => p.lastSeen >= horizon)
    for (const cb of [...s.presenceObservers]) cb(live)
  }

  function send(env: Envelope): void {
    if (!channel.isOpen) return
    try {
      channel.send(JSON.stringify(env))
    } catch {
      // Channel torn down mid-flight — local state already updated; drop.
    }
  }

  channel.on('message', (raw: string) => {
    let env: Envelope
    try {
      const parsed = JSON.parse(raw) as { k?: unknown }
      if (parsed.k !== 'co-fence' && parsed.k !== 'co-presence') return
      env = parsed as Envelope
    } catch {
      return // not our message / malformed JSON
    }

    if (env.k === 'co-fence') {
      const s = stateFor(env.vault)
      s.fence = env.fence
      notifyFence(s)
    } else {
      const s = stateFor(env.vault)
      s.presence.set(env.presence.writerId, env.presence)
      notifyPresence(s)
    }
  })

  return {
    async setFence(vault: string, fence: FenceState): Promise<void> {
      const s = stateFor(vault)
      s.fence = fence
      notifyFence(s)
      send({ k: 'co-fence', vault, fence })
    },

    async readFence(vault: string): Promise<FenceState> {
      return vaults.get(vault)?.fence ?? DEFAULT_FENCE
    },

    observeFence(vault: string, onChange: (f: FenceState) => void): () => void {
      const s = stateFor(vault)
      s.fenceObservers.add(onChange)
      return () => s.fenceObservers.delete(onChange)
    },

    async reportPresence(vault: string, p: WriterPresence): Promise<void> {
      const s = stateFor(vault)
      s.presence.set(p.writerId, p)
      notifyPresence(s)
      send({ k: 'co-presence', vault, presence: p })
    },

    observePresence(vault: string, onChange: (w: readonly WriterPresence[]) => void): () => void {
      const s = stateFor(vault)
      s.presenceObservers.add(onChange)
      return () => s.presenceObservers.delete(onChange)
    },

    async reachableWriters(
      vault: string,
      o: { staleMs: number; now: number },
    ): Promise<readonly WriterPresence[]> {
      const s = vaults.get(vault)
      if (!s) return []
      return prune(s, o.now, o.staleMs)
    },
  }
}
