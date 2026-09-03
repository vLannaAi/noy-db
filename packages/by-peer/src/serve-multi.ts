/**
 * `serveMultiPeerStore()` — the hub of a star: one browser peer accepting
 * N invites instead of 1 (#1239).
 *
 * Mostly assembly. Each accepted invite is exactly one `servePeerStore`
 * instance — its own channel, its own token, its own `allow` set — so
 * everything `servePeerStore` guarantees for the 1:1 case holds per peer here.
 * What this module adds is the part that is NOT assembly: **a token per peer.**
 *
 * - **Revocation is per peer.** Dropping one invite stops serving that peer
 *   and nobody else; a single shared token could not express that.
 * - **Fail-closed survives the widening.** `accept()` requires a non-empty
 *   token, checked at runtime as well as by type, so a multi-peer API can
 *   never turn "no token" into "any peer" — the pre-#1236 behaviour arriving
 *   by another route.
 * - **A token is bound to the channel it was accepted on.** Presenting peer
 *   A's token on peer B's channel is refused, because B's instance only knows
 *   B's token. A token that is already live is refused at `accept()`: one
 *   token, one peer, or revocation and attribution stop meaning anything.
 *
 * ## What the hub peer can and cannot see
 *
 * Star topology makes this peer a single point of failure and of trust. Every
 * invited peer's records pass through it — **as ciphertext.** Hub encrypts
 * before any store is called, so the serving peer holds envelopes it cannot
 * open unless it also holds a keyring for that vault (which, as the vault's
 * own owner, it normally does — this is a session share, not an escrow). What
 * it CAN observe regardless is metadata: which channel called which method
 * on which vault/collection/id, and when.
 *
 * ## Attribution is a decision, not a default
 *
 * With one token "who wrote this" was unanswerable; with a token per peer it
 * becomes answerable, and therefore a choice. This module records **nothing**
 * — it holds `(channel, token)` pairs and no history. A host that wants
 * attribution passes a per-peer decorated `store` in `accept()` and owns the
 * privacy consequences of what it logs.
 *
 * ## No leader election here, deliberately
 *
 * `servePeerStore`'s `leaderElection` exists for a `BroadcastChannel`-backed
 * channel shared by many tabs of ONE origin. An invite is the opposite shape:
 * one channel, one remote peer. A star of invites lives in one tab; if that
 * tab closes, the invites close with it and the peers reconnect through a new
 * one. Layering Web Locks over N distinct channels would need one lock per
 * channel and a story for what a "logical server" is across them — not
 * something a session share needs, and out of scope per the milestone
 * (catalog, locator and discovery belong to the daemon).
 *
 * @module
 */

import type { NoydbStore } from '@noy-db/hub/to'
import type { PeerChannel } from './channel.js'
import { servePeerStore } from './serve.js'

/** One invited peer. */
export interface PeerInvite {
  /** The duplex channel to this one peer. */
  readonly channel: PeerChannel
  /**
   * Bearer token from THIS peer's invite. Required and non-empty; the same
   * token cannot be live on two channels at once.
   */
  readonly token: string
  /**
   * Per-peer method whitelist (e.g. a read-only peer). Overrides the server
   * default for this peer only. NOT authentication — it composes with `token`.
   */
  readonly allow?: ReadonlySet<string>
  /**
   * Serve this peer from a different store — the seam for per-peer
   * attribution or metering decorators. Defaults to the server's store.
   */
  readonly store?: NoydbStore
}

export interface MultiPeerServerOptions {
  /** The local store every accepted peer is served from, unless an invite overrides it. */
  readonly store: NoydbStore
  /** Default method whitelist for every accepted peer. */
  readonly allow?: ReadonlySet<string>
}

export interface MultiPeerServer {
  /**
   * Admit one invited peer. Returns a revoke function for exactly that peer;
   * calling it stops serving that channel and leaves every other peer alone.
   * Idempotent. The channel itself is NOT closed — ownership stays with the
   * caller, as with `servePeerStore`'s dispose.
   *
   * Throws if the token is missing or empty (fail-closed), if that token is
   * already live on another channel, or after `dispose()`.
   */
  accept(invite: PeerInvite): () => void
  /** Peers currently being served. */
  readonly size: number
  /** Revoke every peer. Idempotent; `accept()` refuses afterwards. */
  dispose(): void
}

export function serveMultiPeerStore(opts: MultiPeerServerOptions): MultiPeerServer {
  // token -> revoke. The token is the key because it is what an invite IS;
  // the channel is where it is honoured.
  const peers = new Map<string, () => void>()
  let disposed = false

  return {
    accept(invite) {
      if (disposed) throw new Error('serveMultiPeerStore: this server is disposed and accepts no more invites')
      const token = invite?.token
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(
          'serveMultiPeerStore.accept: an invite needs a non-empty bearer token. ' +
          'A multi-peer server never serves an unauthenticated channel — "no token" ' +
          'must not become "any peer".',
        )
      }
      if (peers.has(token)) {
        throw new Error(
          'serveMultiPeerStore.accept: that token is already live on another channel. ' +
          'One token, one peer — issue a fresh invite (or revoke the existing peer first).',
        )
      }

      const allow = invite.allow ?? opts.allow
      const stop = servePeerStore({
        channel: invite.channel,
        store: invite.store ?? opts.store,
        token,
        ...(allow !== undefined && { allow }),
      })

      let live = true
      const revoke = (): void => {
        if (!live) return
        live = false
        stop()
        offClose()
        peers.delete(token)
      }
      // A closed channel is a departed peer: drop it so its token can be
      // issued again and `size` tells the truth.
      const offClose = invite.channel.on('close', revoke)
      peers.set(token, revoke)
      return revoke
    },

    get size() {
      return peers.size
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const revoke of [...peers.values()]) revoke()
    },
  }
}
