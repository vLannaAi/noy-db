/**
 * @category capability
 * Reactive core for cross-vault live queries/aggregations. Generic over a
 * snapshot S. Single-flight + microtask-coalesced recompute on relevant
 * change. Mirrors the LiveQuery/LiveAggregation contracts via facades.
 * Spec: docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md.
 */
import type { ChangeEvent } from '@noy-db/hub/kernel'

export interface CrossVaultLiveOptions<S> {
  readonly subscribeToChanges: (handler: (e: ChangeEvent) => void) => () => void
  readonly isRelevant: (e: ChangeEvent) => boolean
  readonly compute: () => Promise<S>
  readonly initialSnapshot: S
  readonly debounceMs?: number
}

export class CrossVaultLive<S> {
  snapshot: S
  error: Error | null = null
  readonly ready: Promise<void>

  private readonly subs = new Set<() => void>()
  private readonly unsubChange: () => void
  private readonly opts: CrossVaultLiveOptions<S>
  private stopped = false
  private computing = false
  private dirty = false
  private scheduled = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolveReady!: () => void
  private settledOnce = false

  constructor(opts: CrossVaultLiveOptions<S>) {
    this.opts = opts
    this.snapshot = opts.initialSnapshot
    this.ready = new Promise<void>((res) => { this.resolveReady = res })
    this.unsubChange = opts.subscribeToChanges((e) => {
      if (this.stopped || !opts.isRelevant(e)) return
      this.schedule()
    })
    this.schedule() // initial compute
  }

  subscribe(cb: () => void): () => void {
    if (this.stopped) return () => {}
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unsubChange()
    if (this.timer !== null) clearTimeout(this.timer)
    this.subs.clear()
    if (!this.settledOnce) this.resolveReady() // never leave ready dangling
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.computing) { this.dirty = true; return }
    if (this.scheduled) return
    this.scheduled = true
    const run = () => { this.scheduled = false; void this.runCompute() }
    const ms = this.opts.debounceMs ?? 0
    if (ms > 0) this.timer = setTimeout(run, ms)
    // queueMicrotask is non-cancellable; the `if (this.stopped) return` guard at the top of runCompute makes a post-stop fire a no-op.
    else queueMicrotask(run)
  }

  private async runCompute(): Promise<void> {
    if (this.stopped) return
    this.computing = true
    this.dirty = false
    try {
      const next = await this.opts.compute()
      if (this.stopped) return
      this.snapshot = next
      this.error = null
    } catch (err) {
      if (this.stopped) return
      this.error = err instanceof Error ? err : new Error(String(err))
    } finally {
      this.computing = false
      if (!this.stopped) {
        if (!this.settledOnce) { this.settledOnce = true; this.resolveReady() }
        for (const cb of this.subs) cb()
        if (this.dirty) this.schedule()
      }
    }
  }
}
