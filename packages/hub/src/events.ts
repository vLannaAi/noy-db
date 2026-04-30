import type { NoydbEventMap } from './types.js'

type EventHandler<T> = (data: T) => void

/** Typed event emitter for NOYDB events. */
export class NoydbEventEmitter {
  private readonly listeners = new Map<string, Set<EventHandler<unknown>>>()

  on<K extends keyof NoydbEventMap>(
    event: K,
    handler: EventHandler<NoydbEventMap[K]>,
  ): void {
    let set = this.listeners.get(event as string)
    if (!set) {
      set = new Set()
      this.listeners.set(event as string, set)
    }
    set.add(handler as EventHandler<unknown>)
  }

  off<K extends keyof NoydbEventMap>(
    event: K,
    handler: EventHandler<NoydbEventMap[K]>,
  ): void {
    this.listeners.get(event as string)?.delete(handler as EventHandler<unknown>)
  }

  emit<K extends keyof NoydbEventMap>(event: K, data: NoydbEventMap[K]): void {
    const set = this.listeners.get(event as string)
    if (set) {
      for (const handler of set) {
        handler(data)
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}
