/**
 * **@noy-db/by-tabs** — BroadcastChannel multi-tab transport for noy-db.
 *
 * Wraps the browser `BroadcastChannel` API as a `PeerChannel`, the
 * primitive every `by-*` transport implements. Sub-millisecond fan-out
 * across tabs of the same origin; same code shape as `@noy-db/by-peer`,
 * just a different wire.
 *
 * Compose with `peerStore()` / `servePeerStore()` from `@noy-db/by-peer`
 * for an asymmetric tab-as-remote-store topology, or use the channel
 * directly to publish change events to every other tab.
 *
 * ## Threat model
 *
 * - `BroadcastChannel` is same-origin by browser policy — only documents
 *   served from the same scheme + host + port can subscribe.
 * - noy-db already encrypts at rest — every tab on the channel sees
 *   only AES-256-GCM ciphertext envelopes. The transport never decrypts.
 * - Untrusted tabs (e.g. third-party iframes that share an origin via
 *   `document.domain` legacy) can still see the channel. Treat
 *   BroadcastChannel as origin-scoped, not session-scoped.
 *
 * @packageDocumentation
 */

import type { PeerChannel } from '@noy-db/by-peer'

export type { PeerChannel }

/**
 * Options for `tabsChannel()`.
 */
export interface TabsChannelOptions {
  /**
   * BroadcastChannel name. Two tabs subscribed to the same name see
   * each other's messages. Use a stable, vault-scoped string like
   * `'noy-db:vault-acme'` to keep different vaults isolated.
   */
  readonly name: string
}

/**
 * Wrap a `BroadcastChannel` as a `PeerChannel`.
 *
 * Returns a no-op channel (always `isOpen: false`, no-op `send`) when
 * `BroadcastChannel` is undefined — so server-side rendering, Node
 * scripts, and older browsers can import the package without crashing
 * before they feature-detect.
 */
export function tabsChannel(options: TabsChannelOptions): PeerChannel {
  const name = options.name
  const Bc = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
  if (!Bc) return makeNoopChannel(name)

  const bc = new Bc(name)
  type Listeners = {
    message: Set<(p: string) => void>
    close: Set<() => void>
  }
  const listeners: Listeners = { message: new Set(), close: new Set() }
  let closed = false

  bc.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return
    for (const fn of listeners.message) fn(ev.data)
  })

  function fireClose(): void {
    if (closed) return
    closed = true
    for (const fn of listeners.close) fn()
  }

  return {
    get isOpen() {
      return !closed
    },
    send(payload: string) {
      if (closed) throw new Error('PeerChannel closed')
      bc.postMessage(payload)
    },
    on(event: 'message' | 'close', listener: ((payload: string) => void) | (() => void)): () => void {
      if (event === 'message') {
        listeners.message.add(listener as (p: string) => void)
        return () => listeners.message.delete(listener as (p: string) => void)
      }
      listeners.close.add(listener as () => void)
      return () => listeners.close.delete(listener as () => void)
    },
    close() {
      if (closed) return
      try {
        bc.close()
      } catch {
        // ignore — channel already torn down
      }
      fireClose()
    },
  } as PeerChannel
}

/**
 * Whether `BroadcastChannel` is available in the current runtime. Use
 * this as a pre-flight before rendering UI that relies on tab-to-tab
 * sync — Node, SSR, and a handful of older browsers don't ship it.
 */
export function isTabsChannelAvailable(): boolean {
  return typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'function'
}

// ─── Internals ───────────────────────────────────────────────────────────

function makeNoopChannel(name: string): PeerChannel {
  void name
  return {
    isOpen: false,
    send() {
      throw new Error(
        '[@noy-db/by-tabs] BroadcastChannel is not available in this runtime — use isTabsChannelAvailable() to feature-detect',
      )
    },
    on(_event: 'message' | 'close', _listener: ((p: string) => void) | (() => void)): () => void {
      return () => {}
    },
    close() {},
  } as PeerChannel
}
