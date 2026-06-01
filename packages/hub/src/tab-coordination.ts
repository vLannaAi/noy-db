/**
 * Multi-tab coordination: primary/secondary election (Web Locks)
 * + presence heartbeat (BroadcastChannel). Browser-only; opt-in; no-op
 * when the APIs are absent. The lock/channel interfaces are hub-local
 * (structurally compatible with @noy-db/by-peer + @noy-db/by-tabs, but
 * not imported — those packages depend on hub).
 */
export type TabRole = 'primary' | 'secondary' | 'unknown'
export interface TabPresence { readonly tabId: string; readonly lastSeen: number; readonly role: TabRole }
export type Unsubscribe = () => void

/** Structural subset of the Web Locks API / by-peer's MinimalLockManager. */
export interface TabLockManager {
  request<T>(name: string, options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal }, callback: (lock: unknown) => Promise<T>): Promise<T>
}

/** Structural subset of by-peer's PeerChannel / a BroadcastChannel wrapper. */
export interface TabChannel {
  send(payload: string): void
  on(event: 'message', listener: (payload: string) => void): Unsubscribe
  on(event: 'close', listener: () => void): Unsubscribe
  close(): void
  readonly isOpen: boolean
}

export interface TabCoordinationOptions {
  readonly lockManager?: TabLockManager
  readonly channel?: TabChannel
  readonly tabId?: string
  readonly lockName?: string
  readonly heartbeatMs?: number
  readonly staleMs?: number
  readonly now?: () => number
  /**
   * Close the channel on `dispose()`. Set this only for a channel the
   * coordinator owns (e.g. the one `defaultChannel()` created); leave it
   * false for a caller-injected channel so the coordinator never closes a
   * channel it didn't create. Default: false.
   */
  readonly closeChannelOnDispose?: boolean
  /**
   * Also propagate committed writes to other tabs. Default true:
   * when tab coordination is enabled and a channel is available, a write in
   * one tab refreshes that document in every other tab. Set false to opt out.
   */
  readonly propagateWrites?: boolean
  /**
   * Channel for write propagation — distinct from the presence
   * channel. Default: an inline BroadcastChannel on `noydb:tab-writes`.
   */
  readonly writeChannel?: TabChannel
}

interface PresenceMsg { readonly kind: 'tab-presence'; readonly tabId: string; readonly lastSeen: number; readonly role: TabRole }

export class TabCoordinator {
  readonly tabId: string
  role: TabRole = 'unknown'
  readonly #lockManager: TabLockManager | undefined
  readonly #channel: TabChannel | undefined
  readonly #lockName: string
  readonly #heartbeatMs: number
  readonly #staleMs: number
  readonly #now: () => number
  readonly #peers = new Map<string, TabPresence>()
  readonly #roleHandlers = new Set<(r: TabRole) => void>()
  readonly #tabsHandlers = new Set<(t: TabPresence[]) => void>()
  #ac: AbortController | undefined
  #releaseLock: (() => void) | undefined
  #unsub: Unsubscribe | undefined
  #closeUnsub: Unsubscribe | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  readonly #ownsChannel: boolean
  #started = false
  #disposed = false
  #lastTabsSig = ''

  constructor(opts: TabCoordinationOptions = {}) {
    this.tabId = opts.tabId ?? `tab-${Math.trunc((opts.now ?? (() => 0))())}-${cheapRand()}`
    this.#lockManager = opts.lockManager
    this.#channel = opts.channel
    this.#lockName = opts.lockName ?? 'noydb:tab-primary'
    this.#heartbeatMs = opts.heartbeatMs ?? 2_000
    this.#staleMs = opts.staleMs ?? 6_000
    this.#now = opts.now ?? (() => Date.now())
    this.#ownsChannel = opts.closeChannelOnDispose ?? false
  }

  start(): void {
    if (this.#disposed || this.#started) return
    this.#started = true
    if (this.#channel) {
      this.#unsub = this.#channel.on('message', (p) => this.#onMessage(p))
      this.#closeUnsub = this.#channel.on('close', () => this.#onChannelClose())
      this.#beat()
      this.#timer = setInterval(() => this.#tick(), this.#heartbeatMs)
      const t = this.#timer as unknown as { unref?: () => void }
      if (typeof t.unref === 'function') t.unref()
    }
    if (this.#lockManager) {
      this.#ac = new AbortController()
      this.#setRole('secondary')
      void this.#lockManager
        .request(this.#lockName, { mode: 'exclusive', signal: this.#ac.signal }, () => {
          this.#setRole('primary')
          return new Promise<void>((resolve) => { this.#releaseLock = resolve })
        })
        .catch(() => { /* aborted on dispose */ })
    }
  }

  activeTabs(): TabPresence[] {
    if (!this.#channel) return []
    const cutoff = this.#now() - this.#staleMs
    const self: TabPresence = { tabId: this.tabId, lastSeen: this.#now(), role: this.role }
    const out = [self, ...[...this.#peers.values()].filter((p) => p.lastSeen >= cutoff)]
    return out.sort((a, b) => a.tabId.localeCompare(b.tabId))
  }

  onTabRoleChange(fn: (r: TabRole) => void): Unsubscribe { this.#roleHandlers.add(fn); return () => this.#roleHandlers.delete(fn) }
  onActiveTabsChange(fn: (t: TabPresence[]) => void): Unsubscribe { this.#tabsHandlers.add(fn); return () => this.#tabsHandlers.delete(fn) }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#releaseLock?.()
    this.#ac?.abort()
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined }
    this.#unsub?.()
    this.#closeUnsub?.()
    if (this.#ownsChannel) this.#channel?.close()
    this.#setRole('unknown')
  }

  /** @internal test seam — broadcast one heartbeat now. */
  _beat(): void { this.#beat() }

  #tick(): void {
    this.#prune()
    this.#emitTabs()
    this.#beat()
  }

  #beat(): void {
    if (this.#disposed) return
    if (!this.#channel || !this.#channel.isOpen) return
    const msg: PresenceMsg = { kind: 'tab-presence', tabId: this.tabId, lastSeen: this.#now(), role: this.role }
    this.#channel.send(JSON.stringify(msg))
  }

  #onChannelClose(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined }
    this.#setRole('unknown')
  }

  #onMessage(payload: string): void {
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    if (!isPresenceMsg(msg) || msg.tabId === this.tabId) return
    this.#peers.set(msg.tabId, { tabId: msg.tabId, lastSeen: msg.lastSeen, role: msg.role })
    this.#prune()
    this.#emitTabs()
  }

  #prune(): void {
    const cutoff = this.#now() - this.#staleMs
    for (const [id, p] of this.#peers) if (p.lastSeen < cutoff) this.#peers.delete(id)
  }

  #setRole(role: TabRole): void {
    if (this.role === role) return
    this.role = role
    for (const h of this.#roleHandlers) h(role)
    this.#beat() // announce promptly
    this.#emitTabs()
  }

  #emitTabs(): void {
    const tabs = this.activeTabs()
    const sig = tabs.map((t) => `${t.tabId}:${t.role}`).join('|')
    if (sig === this.#lastTabsSig) return
    this.#lastTabsSig = sig
    for (const h of this.#tabsHandlers) h(tabs)
  }
}

function isPresenceMsg(x: unknown): x is PresenceMsg {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o['kind'] === 'tab-presence'
    && typeof o['tabId'] === 'string'
    && typeof o['lastSeen'] === 'number'
    && (o['role'] === 'primary' || o['role'] === 'secondary' || o['role'] === 'unknown')
}

function cheapRand(): string {
  // Non-crypto, non-Date id suffix for a default tabId; callers pass a stable tabId in tests.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  return g.crypto?.randomUUID ? g.crypto.randomUUID().slice(0, 8) : 'anon'
}

/** Browser default lock manager (navigator.locks) or undefined. */
export function defaultLockManager(): TabLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: TabLockManager } }).navigator
  return nav?.locks
}

/** Browser default channel: an inline BroadcastChannel wrapper, or undefined. */
export function defaultChannel(name = 'noydb:tabs'): TabChannel | undefined {
  // Gate on `window` — a real browser signal. Modern Node exposes a global
  // BroadcastChannel (worker_threads), so presence of the constructor alone is
  // NOT a browser signal; without this gate we'd start a heartbeat in Node.
  // Symmetric with defaultLockManager()'s navigator gate.
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') return undefined
  const Bc = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
  if (!Bc) return undefined
  const bc = new Bc(name)
  const msgListeners = new Set<(p: string) => void>()
  bc.onmessage = (e: MessageEvent) => { for (const l of msgListeners) l(String(e.data)) }
  return {
    isOpen: true,
    send(payload) { bc.postMessage(payload) },
    on(event, listener) {
      if (event === 'message') { const l = listener as (p: string) => void; msgListeners.add(l); return () => msgListeners.delete(l) }
      return () => {}
    },
    close() { msgListeners.clear(); bc.close() },
  }
}
