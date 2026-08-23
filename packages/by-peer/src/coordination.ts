/**
 * **@noy-db/by-peer** real-time {@link NoydbMesh} — the shared
 * drain-barrier core for every `by-*` transport (#469).
 *
 * The kernel defines the {@link NoydbMesh} port; the store default
 * polls `_meta/schema-fence`, but a real-time app can inject this push-based
 * provider so a schema cutover fences **instantly** instead of via store
 * polling. The migration cutover and `@klum-db/lobby` both drive the same port
 * through `mesh`, so neither names a `by-*` package.
 *
 * This module owns the transport-agnostic logic for ANY {@link PeerChannel}:
 * `@noy-db/by-tabs` (BroadcastChannel) delegates to {@link channelMesh}
 * here rather than duplicating the protocol, and the WebRTC peer path uses
 * {@link byPeer} (the same factory, by its by-peer public name).
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
 * A `PeerChannel` does **not** echo a post back to the sender (neither
 * BroadcastChannel nor a WebRTC DataChannel does), so every local op
 * (`setFence`, `reportPresence`) updates this provider's own in-memory state
 * and notifies its own subscribers *before* broadcasting. Remote ends converge
 * via the `message` listener.
 *
 * @module
 */

import type { PeerChannel } from './channel.js'
import type { NoydbMesh, FenceDoc, WriterPresence } from '@noy-db/hub/by'

/** Default fence when a vault has never been fenced. */
const DEFAULT_FENCE: FenceDoc = { currentSchemaVersion: 0, fenceState: 'normal' }

/**
 * Default presence horizon used when pruning before an `observePresence` emit
 * (`reachableWriters` is always given an explicit `staleMs` by the caller). An
 * end that stops heartbeating for longer than this drops out of pushed batches.
 */
const DEFAULT_STALE_MS = 30_000

type FenceEnvelope = { readonly k: 'co-fence'; readonly vault: string; readonly fence: FenceDoc }
type PresenceEnvelope = {
  readonly k: 'co-presence'
  readonly vault: string
  readonly presence: WriterPresence
}
type Envelope = FenceEnvelope | PresenceEnvelope

interface VaultState {
  fence: FenceDoc
  readonly presence: Map<string, WriterPresence>
  readonly fenceObservers: Set<(f: FenceDoc) => void>
  readonly presenceObservers: Set<(w: readonly WriterPresence[]) => void>
}

/**
 * Build a real-time {@link NoydbMesh} backed by any
 * {@link PeerChannel} — the shared core for every `by-*` transport.
 *
 * The provider owns its in-memory fence + presence maps per vault and keeps
 * them in sync with every other end on the channel. Pass it as
 * `createNoydb({ mesh: channelMesh(ch) })`, or drive it
 * directly via `runDrainBarrier`.
 *
 * `@noy-db/by-tabs` re-exports this under the name `byTabs`, and
 * by-peer exposes the same factory as {@link byPeer}.
 */
export function channelMesh(channel: PeerChannel): NoydbMesh {
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
    // Best-effort prune for the *pushed batch* so an end that stopped
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
    async setFence(vault: string, fence: FenceDoc): Promise<void> {
      const s = stateFor(vault)
      s.fence = fence
      notifyFence(s)
      send({ k: 'co-fence', vault, fence })
    },

    async readFence(vault: string): Promise<FenceDoc> {
      return vaults.get(vault)?.fence ?? DEFAULT_FENCE
    },

    observeFence(vault: string, onChange: (f: FenceDoc) => void): () => void {
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

/**
 * by-peer's public name for the shared {@link channelMesh} core — a
 * real-time {@link NoydbMesh} over a WebRTC `PeerChannel` (or any
 * other `PeerChannel`). Inject via
 * `createNoydb({ mesh: byPeer(ch) })`.
 *
 * It is the *same* factory as {@link channelMesh}; both names are
 * exported so callers can pick the one that reads best at the call site.
 */
export const byPeer: (channel: PeerChannel) => NoydbMesh = channelMesh
