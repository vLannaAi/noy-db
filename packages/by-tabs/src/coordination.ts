/**
 * **@noy-db/by-tabs** real-time {@link NoydbMesh} — a drain-barrier
 * transport over a {@link PeerChannel} (BroadcastChannel between tabs).
 *
 * The kernel defines the {@link NoydbMesh} port (#469); the store
 * default polls `_meta/schema-fence`, but a multi-tab app can inject this
 * push-based provider so a schema cutover fences **instantly** instead of via
 * store polling. The migration cutover and `@klum-db/lobby` both drive the same
 * port through `mesh`, so neither names `by-tabs`.
 *
 * ## Shared core
 *
 * The protocol (JSON `co-fence`/`co-presence` envelopes, per-vault fence +
 * presence maps, local-update-before-broadcast, prune-on-read) is transport
 * agnostic — it is **identical** for a BroadcastChannel tab and a WebRTC peer.
 * To stay DRY, that core lives once in `@noy-db/by-peer` as
 * `channelMesh`; `byTabs` is a thin, named delegation. See
 * that module for the wire protocol and local-echo notes.
 *
 * @module
 */

import { channelMesh } from '@noy-db/by-peer'
import type { PeerChannel } from '@noy-db/by-peer'
import type { NoydbMesh } from '@noy-db/hub/cargo'

/**
 * Build a real-time {@link NoydbMesh} backed by a {@link PeerChannel}
 * (a BroadcastChannel between tabs of the same origin).
 *
 * Delegates to the shared `channelMesh` core in `@noy-db/by-peer` — the
 * by-tabs and by-peer transports run the identical drain-barrier protocol, so
 * the logic is not duplicated. Pass it as
 * `createNoydb({ mesh: byTabs(ch) })`, or drive it
 * directly via `runDrainBarrier`.
 */
export function byTabs(channel: PeerChannel): NoydbMesh {
  return channelMesh(channel)
}
