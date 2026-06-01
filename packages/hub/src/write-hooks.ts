/**
 * Hub-level write lifecycle hooks (#230). `onBeforeWrite` may abort (throw);
 * `onAfterWrite` is awaited and its errors are warned, not thrown. A
 * re-entrancy flag suppresses nested firing so a handler that writes can't
 * loop. Held on the Noydb instance, threaded into every Collection.
 */
export interface WriteEvent {
  readonly op: 'create' | 'update' | 'delete'
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly before: unknown // decrypted prior record; null on 'create'
  readonly after: unknown // the record written; null on 'delete'
  readonly userId: string
  readonly timestamp: number
  readonly txId: string
}

export type WriteHook = (event: WriteEvent) => void | Promise<void>
export type Unsubscribe = () => void

export class WriteHookRegistry {
  readonly #before: WriteHook[] = []
  readonly #after: WriteHook[] = []
  #suppressed = false

  /** True while handlers are running — used by the write path to skip nested firing. */
  get suppressed(): boolean { return this.#suppressed }

  /** True when any hook is registered (cheap gate for the write path). */
  get hasHandlers(): boolean { return this.#before.length > 0 || this.#after.length > 0 }

  onBeforeWrite(handler: WriteHook): Unsubscribe {
    this.#before.push(handler)
    return () => { const i = this.#before.indexOf(handler); if (i >= 0) this.#before.splice(i, 1) }
  }

  onAfterWrite(handler: WriteHook): Unsubscribe {
    this.#after.push(handler)
    return () => { const i = this.#after.indexOf(handler); if (i >= 0) this.#after.splice(i, 1) }
  }

  /** Run before-hooks (awaited, in order). A throw propagates and aborts the write. */
  async runBefore(event: WriteEvent): Promise<void> {
    if (this.#before.length === 0) return
    this.#suppressed = true
    try {
      for (const h of this.#before.slice()) await h(event)
    } finally {
      this.#suppressed = false
    }
  }

  /** Run after-hooks (awaited, in order). Per-handler errors are warned, not thrown. */
  async runAfter(event: WriteEvent): Promise<void> {
    if (this.#after.length === 0) return
    this.#suppressed = true
    try {
      for (const h of this.#after.slice()) {
        try {
          await h(event)
        } catch (err) {
          console.warn(
            `[noy-db] onAfterWrite handler failed for ${event.collection}/${event.docId}: ` +
            (err instanceof Error ? err.message : String(err)),
          )
        }
      }
    } finally {
      this.#suppressed = false
    }
  }
}
