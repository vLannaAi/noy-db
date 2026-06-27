/**
 * `PeerChannel` — the minimal duplex message primitive used by the p2p
 * NoydbStore wrapper. Any transport that can deliver UTF-8 strings
 * reliably and in-order qualifies: WebRTC DataChannel, BroadcastChannel,
 * MessagePort, WebSocket, even postMessage pairs.
 *
 * Keeping the transport abstract has three payoffs:
 *
 *   1. **Tests run without a WebRTC polyfill.** `pairInMemory()` returns
 *      two wired channels for conformance tests against `to-memory`.
 *   2. **Consumers pick their signaling story.** Matrix rooms, QR codes,
 *      pastebin, Firebase Realtime DB — the handshake is out of scope.
 *   3. **Future transports slot in cheaply.** WebTransport (HTTP/3),
 *      libp2p, Iroh, or a plain relay WebSocket become additional
 *      bindings without touching the RPC layer.
 *
 * @module
 */

/**
 * Minimal duplex message primitive.
 *
 * Implementations MUST deliver every `send` payload in order exactly
 * once to every live `on('message')` subscriber. `close()` is best-effort
 * — once called, further `send()` calls MAY throw and `on('close')` MUST
 * fire once.
 */
export interface PeerChannel {
  /** Enqueue a payload for delivery to the remote end. */
  send(payload: string): void
  /** Subscribe to incoming payloads or lifecycle events. Returns unsubscribe. */
  on(event: 'message', listener: (payload: string) => void): () => void
  on(event: 'close', listener: () => void): () => void
  /** Close the channel. Idempotent. */
  close(): void
  /** True once the channel is ready for `send`. */
  readonly isOpen: boolean
}

/**
 * Create a pair of in-memory `PeerChannel`s wired to each other.
 * Intended for tests and multi-tab simulations inside a single process.
 */
export function pairInMemory(): [PeerChannel, PeerChannel] {
  type Listeners = {
    message: Set<(p: string) => void>
    close: Set<() => void>
  }

  function make(): { ch: PeerChannel; listeners: Listeners; closed: { v: boolean } } {
    const listeners: Listeners = { message: new Set(), close: new Set() }
    const closed = { v: false }
    const ch: PeerChannel = {
      get isOpen() {
        return !closed.v
      },
      send() {
        // Placeholder — wired below.
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
        if (closed.v) return
        closed.v = true
        for (const fn of listeners.close) fn()
      },
    } as PeerChannel
    return { ch, listeners, closed }
  }

  const a = make()
  const b = make()

  function closeBoth(): void {
    if (!a.closed.v) {
      a.closed.v = true
      for (const fn of a.listeners.close) fn()
    }
    if (!b.closed.v) {
      b.closed.v = true
      for (const fn of b.listeners.close) fn()
    }
  }

  a.ch.send = (payload) => {
    if (b.closed.v) throw new Error('PeerChannel closed')
    queueMicrotask(() => {
      for (const fn of b.listeners.message) fn(payload)
    })
  }
  b.ch.send = (payload) => {
    if (a.closed.v) throw new Error('PeerChannel closed')
    queueMicrotask(() => {
      for (const fn of a.listeners.message) fn(payload)
    })
  }
  a.ch.close = closeBoth
  b.ch.close = closeBoth

  return [a.ch, b.ch]
}

/**
 * Wrap a WebRTC `RTCDataChannel` as a `PeerChannel`.
 *
 * Browser-only — the caller is responsible for establishing the
 * `RTCPeerConnection`, exchanging SDP offers/answers out of band, and
 * passing the opened DataChannel here. When the remote peer is only
 * reachable via TURN, the relay sees DTLS-wrapped ciphertext (noy-db
 * already encrypts at rest, so even a TURN compromise leaks nothing).
 */
export function fromDataChannel(dc: RTCDataChannel): PeerChannel {
  type Listeners = {
    message: Set<(p: string) => void>
    close: Set<() => void>
  }
  const listeners: Listeners = { message: new Set(), close: new Set() }
  let closed = false

  dc.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return
    for (const fn of listeners.message) fn(ev.data)
  })
  dc.addEventListener('close', () => {
    if (closed) return
    closed = true
    for (const fn of listeners.close) fn()
  })

  return {
    get isOpen() {
      return !closed && dc.readyState === 'open'
    },
    send(payload) {
      if (closed || dc.readyState !== 'open') {
        throw new Error(`PeerChannel not open (readyState: ${dc.readyState})`)
      }
      dc.send(payload)
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
      closed = true
      try {
        dc.close()
      } catch {
        // ignore — channel already torn down
      }
      for (const fn of listeners.close) fn()
    },
  } as PeerChannel
}
