/**
 * Per-client schema-fence watcher (#232 sub-slice 3b). Polls the fence;
 * on `draining` it drains in-flight writes and acks; emits a same-instance
 * signal on every state transition (for #233's UI). Driven by an interval
 * in production and by explicit `check()`/`beat()` in tests.
 */
import type { NoydbStore } from '../types.js'
import { loadFence, type FenceState } from './fence.js'
import { writeClientDoc } from './client-registry.js'

export interface FenceWatcherEvent {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
}

export class FenceWatcher {
  readonly #store: NoydbStore
  readonly #vault: string
  readonly #clientId: string
  readonly #onFlush: () => Promise<void>
  readonly #now: () => number
  readonly #emit: (e: FenceWatcherEvent) => void
  #lastState: FenceState | null = null
  #quiescedAtVersion: number | null = null
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: {
    store: NoydbStore
    vault: string
    clientId: string
    onFlush: () => Promise<void>
    now?: () => number
    emit?: (e: FenceWatcherEvent) => void
  }) {
    this.#store = opts.store
    this.#vault = opts.vault
    this.#clientId = opts.clientId
    this.#onFlush = opts.onFlush
    this.#now = opts.now ?? (() => Date.now())
    this.#emit = opts.emit ?? (() => {})
  }

  /** Publish liveness (and the current ack) without changing quiesce state. */
  async beat(): Promise<void> {
    await writeClientDoc(this.#store, this.#vault, this.#clientId, {
      lastSeen: this.#now(),
      quiescedAtVersion: this.#quiescedAtVersion,
    })
  }

  /** Poll the fence; quiesce on draining; emit on transitions. */
  async check(): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
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
