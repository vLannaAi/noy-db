/**
 * Per-client schema-fence watcher. Watches the fence via the injected
 * {@link CoordinationProvider}; on `draining` it drains in-flight writes
 * and reports presence (its ack); emits a same-instance signal on every
 * state transition (for UI). Driven by an interval in production and by
 * explicit `check()`/`beat()` in tests.
 *
 * The transport is the coordination port: the default
 * {@link StoreCoordinationProvider} maps `reportPresence` →
 * `_meta/schema-fence:client:<id>` and `readFence` → `_meta/schema-fence`,
 * so behavior is byte-for-byte the same; `by-tabs` / `by-peer` swap in
 * real-time push transports.
 */
import { type FenceState } from './fence.js'
import type { CoordinationProvider } from '../coordination/index.js'

export interface FenceWatcherEvent {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
}

export class FenceWatcher {
  readonly #coordination: CoordinationProvider
  readonly #vault: string
  readonly #writerId: string
  readonly #sessionId: string
  readonly #onFlush: () => Promise<void>
  readonly #now: () => number
  readonly #emit: (e: FenceWatcherEvent) => void
  #lastState: FenceState | null = null
  #quiescedAtVersion: number | null = null
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    coordination: CoordinationProvider
    vault: string
    clientId: string
    sessionId?: string
    onFlush: () => Promise<void>
    now?: () => number
    emit?: (e: FenceWatcherEvent) => void
  }) {
    this.#coordination = opts.coordination
    this.#vault = opts.vault
    this.#writerId = opts.clientId
    this.#sessionId = opts.sessionId ?? opts.clientId
    this.#onFlush = opts.onFlush
    this.#now = opts.now ?? (() => Date.now())
    this.#emit = opts.emit ?? (() => {})
  }

  /** Publish liveness (and the current ack) without changing quiesce state. */
  async beat(): Promise<void> {
    await this.#coordination.reportPresence(this.#vault, {
      writerId: this.#writerId,
      sessionId: this.#sessionId,
      lastSeen: this.#now(),
      quiescedAtVersion: this.#quiescedAtVersion,
    })
  }

  /** Poll the fence; quiesce on draining; emit on transitions. */
  async check(): Promise<void> {
    const fence = await this.#coordination.readFence(this.#vault)
    if (fence.fenceState !== this.#lastState) {
      this.#lastState = fence.fenceState
      this.#emit({ currentSchemaVersion: fence.currentSchemaVersion, fenceState: fence.fenceState })
    }
    if (fence.fenceState === 'draining' && this.#quiescedAtVersion !== fence.currentSchemaVersion) {
      await this.#onFlush()
      this.#quiescedAtVersion = fence.currentSchemaVersion
      await this.beat()
    }
    if (fence.fenceState === 'normal') {
      this.#quiescedAtVersion = null
    }
  }

  start(intervalMs: number): void {
    if (this.#timer) return
    this.#timer = setInterval(() => { void this.beat(); void this.check() }, intervalMs)
    const timer = this.#timer as unknown as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref() // don't keep the process alive
  }

  stop(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined }
  }
}
