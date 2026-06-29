import { describe, expect, it, vi } from 'vitest'
import { WriteHookRegistry, type WriteEvent } from '../src/write-hooks.js'

const evt = (over: Partial<WriteEvent> = {}): WriteEvent => ({
  op: 'create', vault: 'v1', collection: 'invoices', docId: 'i1',
  before: null, after: { id: 'i1' }, baseVersion: 0, version: 1, userId: 'u', timestamp: 0, txId: 't', ...over,
})

describe('WriteHookRegistry', () => {
  it('runBefore is a no-op with no handlers', async () => {
    const r = new WriteHookRegistry()
    await expect(r.runBefore(evt())).resolves.toBeUndefined()
    expect(r.hasHandlers).toBe(false)
  })

  it('fires before-handlers in registration order; unsubscribe removes them', async () => {
    const r = new WriteHookRegistry()
    const seen: number[] = []
    const off1 = r.onBeforeWrite(() => { seen.push(1) })
    r.onBeforeWrite(() => { seen.push(2) })
    await r.runBefore(evt())
    expect(seen).toEqual([1, 2])
    off1()
    await r.runBefore(evt())
    expect(seen).toEqual([1, 2, 2])
  })

  it('a throwing before-handler propagates and short-circuits the rest', async () => {
    const r = new WriteHookRegistry()
    const second = vi.fn()
    r.onBeforeWrite(() => { throw new Error('veto') })
    r.onBeforeWrite(second)
    await expect(r.runBefore(evt())).rejects.toThrow('veto')
    expect(second).not.toHaveBeenCalled()
  })

  it('after-handler errors are swallowed (warned), not thrown', async () => {
    const r = new WriteHookRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.onAfterWrite(() => { throw new Error('boom') })
    const ran = vi.fn()
    r.onAfterWrite(ran)
    await expect(r.runAfter(evt())).resolves.toBeUndefined()
    expect(ran).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('suppressed during handler execution (re-entrancy guard)', async () => {
    const r = new WriteHookRegistry()
    let seenWhileRunning: boolean | undefined
    r.onBeforeWrite(() => { seenWhileRunning = r.suppressed })
    expect(r.suppressed).toBe(false)
    await r.runBefore(evt())
    expect(seenWhileRunning).toBe(true)
    expect(r.suppressed).toBe(false)
  })

  it('suppressed is cleared even when a before-handler throws', async () => {
    const r = new WriteHookRegistry()
    r.onBeforeWrite(() => { throw new Error('x') })
    await expect(r.runBefore(evt())).rejects.toThrow('x')
    expect(r.suppressed).toBe(false)
  })
})
