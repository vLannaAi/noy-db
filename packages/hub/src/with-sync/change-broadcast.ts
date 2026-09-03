/**
 * Cross-tab / cross-process change signals for `.live()` — #1362.
 *
 * A live query is in-process only: a write in tab A leaves tab B's `.live()`
 * showing the old rows until B happens to read again. This module closes that
 * without an external coordinator: every locally-committed change posts a
 * compact ADDRESS on a channel named per store, and every listening instance
 * re-reads that address **through its own keyring** and re-fires the live
 * queries that touch it.
 *
 * ## The zero-knowledge constraint is the feature
 *
 * The frame is `{ vault, collection, id, ts }` and nothing else. No record, no
 * field, no ciphertext, no key, not even the VERB — see below. Encryption
 * happens in hub before any store, and a broadcast channel is **not a store**:
 * it is a side channel with no authentication and no access control, so it is
 * treated as untrusted in BOTH directions.
 *
 *   - **Untrusted egress** — only the address leaves. A peer that should not
 *     be able to read a record learns, at most, that a record at that address
 *     changed. `change-broadcast.test.ts` asserts on the exact bytes posted and
 *     fails if anything resembling record content ever appears in them; that
 *     test is the thing that catches a future change which starts sending
 *     payloads.
 *   - **Untrusted ingress** — the frame carries no `action`. A peer's claim
 *     "this was a delete" is not evidence, and it is free not to need it: the
 *     receiver re-reads the address and decides the verb from what IT can
 *     decrypt. So a hostile or buggy peer on the channel can cost a wasted
 *     re-read, and cannot make a receiver report a state its own store does
 *     not hold.
 *
 * ## Why the receiver re-reads rather than patches
 *
 * #1341's `LiveMaintainer` patches a result set from a delta it TRUSTS —
 * trustworthy because it was derived from a local write the same process
 * observed, with the record in hand. A remote signal is a different animal: it
 * says only "id X in collection Y changed", and the receiving instance has not
 * decrypted the new record and knows neither the before nor the after state.
 * Feeding it to the maintainer as if it were a local delta would patch a set
 * from an address. So a remote-origin change re-reads and re-runs: the
 * `ChangeEvent` it produces is tagged `remote: true`, and `Collection`'s query
 * source hands the live query NO delta for such an event — which the maintainer
 * already understands as "rebuild from scratch", the pre-#1341 behaviour.
 *
 * ## Transport
 *
 * `BroadcastChannel` when the host has one (browsers, Node >= 18,
 * Deno, Bun) — feature-detected at enable time, never assumed. With no channel
 * the whole feature is an inert no-op and behaviour is exactly what it is
 * today. Any other host transport (Electron IPC, a worker `MessagePort`, a
 * test bus) is supported by passing a `channel` that satisfies `TabChannel`.
 */
import type { TabChannel, Unsubscribe } from './tab-coordination.js'
import type { ChangeEvent } from '../kernel/types.js'

/**
 * The frame on the wire. `kind` discriminates it from any other traffic
 * sharing the channel; `origin` identifies the sender so a channel that echoes
 * to itself cannot feed an instance its own signal.
 *
 * ⛔ **Do not add a field carrying record state to this interface.** Not the
 * record, not a field of it, not a hash of it, not the verb. Everything here
 * is an ADDRESS plus routing. The test asserting on the posted bytes is what
 * holds the line; it will fail loudly, which is the point.
 */
export interface ChangeSignal {
  readonly kind: 'noydb:change'
  /** Sending instance's id — an incoming frame with our own id is ignored. */
  readonly origin: string
  readonly vault: string
  readonly collection: string
  readonly id: string
  /** Sender's wall clock at post time. Diagnostic only; never compared for ordering. */
  readonly ts: number
}

export interface ChangeBroadcastOptions {
  /**
   * Host-provided transport. Supply this for a host with no
   * `BroadcastChannel` (Electron IPC, a worker `MessagePort`, a test bus) or to
   * take ownership of the channel's lifetime. Default: an inline
   * `BroadcastChannel` if the host has one, else nothing at all.
   */
  readonly channel?: TabChannel
  /**
   * Discriminator for the default channel name — `noydb:change:<storeId>`.
   *
   * ⚠️ Defaults to `store.name`, which is the backend KIND ('memory', 'file',
   * 'idb'), not a per-dataset identity: two different IndexedDB databases both
   * reporting `'idb'` would share one channel and re-read each other's
   * addresses (harmless — a miss costs one read that finds nothing — but
   * wasteful). Pass a `storeId` that names the DATASET whenever a host can
   * open more than one.
   */
  readonly storeId?: string
  /** This instance's id. Default: a random one. */
  readonly originId?: string
  /** Clock for the frame's `ts`. Default: `Date.now`. */
  readonly now?: () => number
}

/** The slice of `Noydb` this needs. Structural, so there is no import cycle. */
export interface ChangeBroadcastHost {
  on(event: 'change', handler: (e: ChangeEvent) => void): void
  off(event: 'change', handler: (e: ChangeEvent) => void): void
  /** @internal Store backend name, for the default channel name. */
  readonly _storeName: string | undefined
  /** @internal Re-read one address through this instance's own keyring. */
  _applyRemoteSignal(vault: string, collection: string, id: string): Promise<void>
}

/**
 * An inline `BroadcastChannel` wrapper, or `undefined` when the host has none.
 *
 * ⚠️ Deliberately does NOT gate on `window`, and that asymmetry with
 * `defaultChannel()` is the cross-process half of this feature, not an
 * oversight. That gate exists because a presence HEARTBEAT and a Web-Locks role
 * ELECTION are browser-tab concepts that should not start running in Node; a
 * change signal is the opposite — Node workers and Electron processes sharing a
 * store are exactly the case #1362 names, and gating on `window` would silently
 * exclude them.
 */
export function defaultChangeChannel(name: string): TabChannel | undefined {
  const Bc = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
  if (typeof Bc !== 'function') return undefined
  const bc = new Bc(name)
  // Node's BroadcastChannel is an active handle and would keep a process alive
  // for a listener nobody is waiting on. Browsers have no such method.
  const maybeUnref = bc as unknown as { unref?: () => void }
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
  const listeners = new Set<(p: string) => void>()
  bc.onmessage = (e: MessageEvent) => { for (const l of listeners) l(String(e.data)) }
  return {
    isOpen: true,
    send(payload) { bc.postMessage(payload) },
    on(event, listener) {
      if (event === 'message') { const l = listener as (p: string) => void; listeners.add(l); return () => listeners.delete(l) }
      return () => {}
    },
    close() { listeners.clear(); bc.close() },
  }
}

/** Channel name for a store. One namespace per store so unrelated datasets never cross-signal. */
export function changeChannelName(storeId: string): string {
  return `noydb:change:${storeId}`
}

/**
 * The relay itself: local change out as an address, remote address in as a
 * re-read. Started by {@link enableChangeBroadcast}.
 */
export class ChangeBroadcast {
  readonly #host: ChangeBroadcastHost
  readonly #channel: TabChannel
  readonly #originId: string
  readonly #now: () => number
  readonly #ownsChannel: boolean
  #unsubMsg: Unsubscribe | undefined
  #started = false
  #disposed = false

  constructor(host: ChangeBroadcastHost, channel: TabChannel, opts: { originId: string; now: () => number; ownsChannel: boolean }) {
    this.#host = host
    this.#channel = channel
    this.#originId = opts.originId
    this.#now = opts.now
    this.#ownsChannel = opts.ownsChannel
  }

  get originId(): string { return this.#originId }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#unsubMsg = this.#channel.on('message', (p) => this.#onMessage(p))
    this.#host.on('change', this.#onLocalChange)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#host.off('change', this.#onLocalChange)
    this.#unsubMsg?.()
    if (this.#ownsChannel) this.#channel.close()
  }

  /**
   * Echo suppression, first and primary layer: a change this instance produced
   * BY APPLYING a peer's signal is tagged `remote` and is never re-posted. Two
   * instances would otherwise volley one address forever.
   */
  readonly #onLocalChange = (e: ChangeEvent): void => {
    if (this.#disposed || e.remote === true) return
    if (!this.#channel.isOpen) return
    const signal: ChangeSignal = {
      kind: 'noydb:change',
      origin: this.#originId,
      vault: e.vault,
      collection: e.collection,
      id: e.id,
      ts: this.#now(),
    }
    this.#channel.send(JSON.stringify(signal))
  }

  #onMessage(payload: string): void {
    if (this.#disposed) return
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    // Echo suppression, second layer: `BroadcastChannel` does not deliver to the
    // poster, but a host transport (or a same-process test bus) may, and the
    // origin check makes the relay correct on either.
    if (!isChangeSignal(msg) || msg.origin === this.#originId) return
    void Promise.resolve(this.#host._applyRemoteSignal(msg.vault, msg.collection, msg.id)).catch((err) => {
      console.warn(`[noy-db] change-signal apply failed for ${msg.collection}/${msg.id}: ` + (err instanceof Error ? err.message : String(err)))
    })
  }
}

/**
 * Opt in to cross-tab / cross-process live-query reactivity.
 *
 * ```ts
 * const stop = enableChangeBroadcast(db, { storeId: 'invoices-2026' })
 * // …a put in another tab now re-fires this tab's `.live()` queries…
 * stop.dispose()
 * ```
 *
 * Opt-in on purpose: it is a side channel, and a host that does not want one
 * gets exactly today's behaviour by not calling this. **With no channel
 * available it is also a no-op** — it returns a disposable that does nothing,
 * never throws, and leaves in-process reactivity untouched.
 */
export function enableChangeBroadcast(host: ChangeBroadcastHost, opts: ChangeBroadcastOptions = {}): { dispose: () => void } {
  const storeId = opts.storeId ?? host._storeName ?? 'default'
  const channel = opts.channel ?? defaultChangeChannel(changeChannelName(storeId))
  if (!channel) return { dispose: () => {} }
  const relay = new ChangeBroadcast(host, channel, {
    originId: opts.originId ?? `noydb-${cheapRand()}`,
    now: opts.now ?? (() => Date.now()),
    // Own the channel only when we created it; never close a caller-injected one.
    ownsChannel: opts.channel === undefined,
  })
  relay.start()
  return { dispose: () => relay.dispose() }
}

function isChangeSignal(x: unknown): x is ChangeSignal {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o['kind'] === 'noydb:change'
    && typeof o['origin'] === 'string'
    && typeof o['vault'] === 'string'
    && typeof o['collection'] === 'string'
    && typeof o['id'] === 'string'
    && typeof o['ts'] === 'number'
}

function cheapRand(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  return g.crypto?.randomUUID ? g.crypto.randomUUID() : `anon-${Math.random().toString(36).slice(2)}`
}
