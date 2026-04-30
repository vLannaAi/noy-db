import { describe, it, expect } from 'vitest'
import { tabsChannel, isTabsChannelAvailable } from '../src/index.js'

describe('@noy-db/by-tabs', () => {
  it('isTabsChannelAvailable reflects runtime support', () => {
    expect(isTabsChannelAvailable()).toBe(true) // happy-dom ships BroadcastChannel
  })

  it('two channels on the same name see each other\'s messages', async () => {
    const a = tabsChannel({ name: 'noy-db:test-vault' })
    const b = tabsChannel({ name: 'noy-db:test-vault' })

    const received: string[] = []
    const unsub = b.on('message', (msg) => received.push(msg))

    a.send('hello-from-a')
    a.send('second')

    // BroadcastChannel dispatches asynchronously — wait a tick.
    await new Promise((r) => setTimeout(r, 20))

    expect(received).toEqual(['hello-from-a', 'second'])

    unsub()
    a.close()
    b.close()
  })

  it('a channel does not see its own posts (BroadcastChannel semantics)', async () => {
    const a = tabsChannel({ name: 'noy-db:loopback' })
    const own: string[] = []
    a.on('message', (msg) => own.push(msg))

    a.send('echo-test')
    await new Promise((r) => setTimeout(r, 20))

    expect(own).toEqual([]) // Sender never receives its own message
    a.close()
  })

  it('different names are isolated', async () => {
    const a = tabsChannel({ name: 'noy-db:a' })
    const b = tabsChannel({ name: 'noy-db:b' })
    const seen: string[] = []
    b.on('message', (msg) => seen.push(msg))

    a.send('only-on-a')
    await new Promise((r) => setTimeout(r, 20))

    expect(seen).toEqual([])
    a.close()
    b.close()
  })

  it('close() flips isOpen and fires the close listener', () => {
    const ch = tabsChannel({ name: 'noy-db:closing' })
    let closed = false
    ch.on('close', () => { closed = true })

    expect(ch.isOpen).toBe(true)
    ch.close()
    expect(ch.isOpen).toBe(false)
    expect(closed).toBe(true)
  })

  it('send after close throws', () => {
    const ch = tabsChannel({ name: 'noy-db:after-close' })
    ch.close()
    expect(() => ch.send('boom')).toThrow(/closed/)
  })
})
