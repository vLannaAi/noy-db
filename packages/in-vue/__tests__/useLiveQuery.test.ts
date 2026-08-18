/**
 * `useLiveQuery` — the Vue mirror of a hub `LiveQuery` (#1131).
 *
 * Driven by a hand-built fake rather than a real vault, deliberately: the
 * behaviour under test is the SUBSCRIPTION GLUE (when refs update, when the
 * error is re-read, when teardown fires), and a real query would couple these
 * rows to hub's executor without exercising anything extra.
 *
 * The reactivity row is the one that matters most. A test that only reads
 * `items.value` passes even when Vue reactivity is completely broken, because
 * the ref's value is correct whether or not anything was notified — so these
 * assert through a `watch`/`effectScope`, which is what a component actually
 * depends on.
 */
import { describe, it, expect, vi } from 'vitest'
import { effectScope, watch, nextTick, isShallow } from 'vue'
import { useLiveQuery, type UseLiveQueryReturn } from '../src/useLiveQuery.js'
import type { LiveQuery } from '@noy-db/hub'

/**
 * Minimal `LiveQuery` double. `emit()` mimics hub's contract: recompute to a
 * FRESH array, then notify — verified against `buildLiveQuery`, where
 * `refresh()` assigns `this._value = this.recompute()`.
 */
function fakeLive<T>(initial: T[]): LiveQuery<T> & {
  emit(next: T[], err?: Error | null): void
  stopped: () => boolean
  listeners: () => number
} {
  let value: readonly T[] = initial
  let error: Error | null = null
  let stopped = false
  const subs = new Set<() => void>()
  return {
    get value() { return value },
    get error() { return error },
    subscribe(cb: () => void) {
      if (stopped) return () => {}
      subs.add(cb)
      return () => subs.delete(cb)
    },
    stop() { stopped = true; subs.clear() },
    emit(next: T[], err: Error | null = null) {
      value = [...next] // fresh reference, as hub does
      error = err
      for (const cb of subs) cb()
    },
    stopped: () => stopped,
    listeners: () => subs.size,
  } as LiveQuery<T> & { emit(next: T[], err?: Error | null): void; stopped: () => boolean; listeners: () => number }
}

describe('useLiveQuery', () => {
  it('seeds items and error from the live query without waiting for a notification', () => {
    const live = fakeLive([{ id: 'a' }])
    const { items, error } = useLiveQuery(live)
    expect(items.value).toEqual([{ id: 'a' }])
    expect(error.value).toBeNull()
  })

  it('TRIGGERS VUE REACTIVITY on a notification, not merely a correct read', async () => {
    // The load-bearing row. `items.value` would read correctly even if nothing
    // were reactive at all, so assert that a watcher actually fires.
    const live = fakeLive<{ id: string }>([])
    const scope = effectScope()
    const seen: number[] = []
    let handle!: UseLiveQueryReturn<{ id: string }>
    scope.run(() => {
      handle = useLiveQuery(live)
      watch(handle.items, (rows) => seen.push(rows.length))
    })

    live.emit([{ id: 'a' }, { id: 'b' }])
    await nextTick()
    expect(seen, 'watcher did not fire — the ref was assigned an equal reference')
      .toEqual([2])
    expect(handle.items.value).toHaveLength(2)
    scope.stop()
  })

  it('re-reads error on EVERY notification, and clears it on recovery', async () => {
    // The semantic a hand-rolled two-line wrapper gets wrong: reading `error`
    // once at construction reports the first failure and then renders stale
    // rows silently forever.
    const live = fakeLive<{ id: string }>([])
    const { items, error } = useLiveQuery(live)
    expect(error.value).toBeNull()

    const boom = new Error('DanglingReferenceError')
    live.emit([], boom)
    expect(error.value).toBe(boom)

    live.emit([{ id: 'a' }])
    expect(error.value, 'a later successful re-run must clear the error').toBeNull()
    expect(items.value).toEqual([{ id: 'a' }])
  })

  it('uses a shallowRef — the rows array is not deeply reactive', () => {
    // Deep reactivity over query results would proxy every record on every
    // re-run. shallowRef is correct precisely because hub replaces the array.
    const live = fakeLive([{ id: 'a' }])
    const { items } = useLiveQuery(live)
    expect(isShallow(items)).toBe(true)
  })

  it('stop() unsubscribes AND stops the upstream query, and is idempotent', () => {
    const live = fakeLive([{ id: 'a' }])
    const { stop } = useLiveQuery(live)
    expect(live.listeners()).toBe(1)
    stop()
    expect(live.listeners()).toBe(0)
    expect(live.stopped()).toBe(true)
    expect(() => stop()).not.toThrow()
  })

  it('after stop(), a further notification cannot mutate the refs', () => {
    const live = fakeLive<{ id: string }>([])
    const { items, stop } = useLiveQuery(live)
    stop()
    live.emit([{ id: 'zombie' }])
    expect(items.value).toEqual([])
  })

  it('disposes automatically when the surrounding effect scope stops', () => {
    const live = fakeLive([{ id: 'a' }])
    const scope = effectScope()
    scope.run(() => { useLiveQuery(live) })
    expect(live.stopped()).toBe(false)
    scope.stop()
    expect(live.stopped(), 'onScopeDispose did not tear the query down').toBe(true)
  })

  it('outside an effect scope it does NOT warn, and stop() stays the caller job', () => {
    // getCurrentScope() is null in a bare harness or at SSR top level. Vue
    // warns if onScopeDispose is called there, so registration is skipped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const live = fakeLive([{ id: 'a' }])
    const { stop } = useLiveQuery(live)
    expect(warn).not.toHaveBeenCalled()
    expect(live.stopped()).toBe(false)
    stop()
    expect(live.stopped()).toBe(true)
    warn.mockRestore()
  })
})
