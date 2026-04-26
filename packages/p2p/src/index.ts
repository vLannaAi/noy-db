/**
 * **@noy-db/p2p** — WebRTC peer-to-peer transport for noy-db.
 *
 * Ships three pieces:
 *
 *   1. **`peerStore()`** — a `NoydbStore` that RPCs every operation to a
 *      remote peer. Slots into `NoydbOptions.sync` as a `SyncTarget`
 *      with `role: 'sync-peer'` — the sync engine treats it exactly like
 *      any other store.
 *
 *   2. **`servePeerStore()`** — the remote-side listener that funnels
 *      incoming RPCs into the local store.
 *
 *   3. **`createOffer()` / `acceptOffer()`** — thin WebRTC handshake
 *      helpers. Signaling is out of scope — the caller ferries SDP
 *      blobs over QR codes, Matrix rooms, pastebins, or whatever.
 *
 * The transport is abstract: anything that implements `PeerChannel`
 * (reliable, in-order, string messages) works. `pairInMemory()` is the
 * test/dev helper that wires two channels together in one process.
 *
 * ## Threat model
 *
 * - Peer-to-peer DTLS protects the wire.
 * - noy-db already encrypts at rest — the remote peer, any TURN relay,
 *   and any on-path observer see only E2E ciphertext envelopes.
 * - The opt-in `allow` whitelist on `servePeerStore` enables read-only
 *   or append-only peers (e.g. `allow = ['get', 'list', 'loadAll']`).
 *
 * @packageDocumentation
 */

export type { PeerChannel } from './channel.js'
export { pairInMemory, fromDataChannel } from './channel.js'
export type { RpcMessage, RpcRequest, RpcResponse, RpcHandler, RpcClientOptions } from './rpc.js'
export { createRpcClient, serveRpc } from './rpc.js'
export type { PeerStoreOptions } from './peer-store.js'
export { peerStore } from './peer-store.js'
export type { ServePeerStoreOptions } from './serve.js'
export { servePeerStore } from './serve.js'
export type { WebRTCOptions, Initiator, Responder } from './webrtc.js'
export { createOffer, acceptOffer } from './webrtc.js'
