import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  requestPersistence,
  captureInstallPrompt,
  getDisplayContext,
  isIosSafari,
  watchOnline,
} from '../src/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// requestPersistence
// ---------------------------------------------------------------------------

interface StorageStub {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ quota?: number; usage?: number }>
}

function stubStorage(storage: StorageStub | undefined): void {
  vi.stubGlobal('navigator', storage === undefined ? {} : { storage })
}

describe('requestPersistence', () => {
  it("'unsupported' when navigator.storage is absent — never throws", async () => {
    stubStorage(undefined)
    await expect(requestPersistence()).resolves.toEqual({
      persisted: false,
      grantedBy: 'unsupported',
    })
  })

  it("'unsupported' when navigator itself is absent", async () => {
    vi.stubGlobal('navigator', undefined)
    await expect(requestPersistence()).resolves.toEqual({
      persisted: false,
      grantedBy: 'unsupported',
    })
  })

  it("'already' when the origin was persistent before the call", async () => {
    stubStorage({
      persisted: async () => true,
      persist: vi.fn(async () => true),
      estimate: async () => ({ quota: 1000, usage: 10 }),
    })
    await expect(requestPersistence()).resolves.toEqual({
      persisted: true,
      grantedBy: 'already',
      quota: 1000,
      usage: 10,
    })
  })

  it("'granted' when persist() succeeds", async () => {
    stubStorage({
      persisted: async () => false,
      persist: async () => true,
      estimate: async () => ({ quota: 500, usage: 5 }),
    })
    await expect(requestPersistence()).resolves.toEqual({
      persisted: true,
      grantedBy: 'granted',
      quota: 500,
      usage: 5,
    })
  })

  it("'denied' when persist() is declined", async () => {
    stubStorage({ persisted: async () => false, persist: async () => false })
    await expect(requestPersistence()).resolves.toEqual({
      persisted: false,
      grantedBy: 'denied',
    })
  })

  it("a throwing Storage API resolves to 'unsupported', never throws", async () => {
    stubStorage({
      persisted: async () => {
        throw new Error('blocked')
      },
      persist: async () => {
        throw new Error('blocked')
      },
    })
    await expect(requestPersistence()).resolves.toEqual({
      persisted: false,
      grantedBy: 'unsupported',
    })
  })

  it('a failing estimate() does not mask the persistence answer', async () => {
    stubStorage({
      persisted: async () => false,
      persist: async () => true,
      estimate: async () => {
        throw new Error('nope')
      },
    })
    await expect(requestPersistence()).resolves.toEqual({
      persisted: true,
      grantedBy: 'granted',
    })
  })
})

// ---------------------------------------------------------------------------
// captureInstallPrompt
// ---------------------------------------------------------------------------

function makeBeforeInstallPromptEvent(outcome: 'accepted' | 'dismissed') {
  const prompt = vi.fn(async () => {})
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  })
  return { event, prompt }
}

describe('captureInstallPrompt', () => {
  it("resolves 'unavailable' when the event never fired (iOS / already installed)", async () => {
    const handle = captureInstallPrompt(new EventTarget())
    expect(handle.captured).toBe(false)
    await expect(handle.promptInstall()).resolves.toBe('unavailable')
  })

  it('captures the event (suppressing the default mini-infobar) and re-fires it deferred', async () => {
    const target = new EventTarget()
    const handle = captureInstallPrompt(target)
    const { event, prompt } = makeBeforeInstallPromptEvent('accepted')

    target.dispatchEvent(event)
    expect(handle.captured).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(prompt).not.toHaveBeenCalled() // deferred until promptInstall()

    await expect(handle.promptInstall()).resolves.toBe('accepted')
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('reports the dismissed outcome', async () => {
    const target = new EventTarget()
    const handle = captureInstallPrompt(target)
    target.dispatchEvent(makeBeforeInstallPromptEvent('dismissed').event)
    await expect(handle.promptInstall()).resolves.toBe('dismissed')
  })

  it("the deferred prompt is single-use: second call resolves 'unavailable'", async () => {
    const target = new EventTarget()
    const handle = captureInstallPrompt(target)
    target.dispatchEvent(makeBeforeInstallPromptEvent('accepted').event)

    await expect(handle.promptInstall()).resolves.toBe('accepted')
    expect(handle.captured).toBe(false)
    await expect(handle.promptInstall()).resolves.toBe('unavailable')
  })

  it('dispose() removes the listener and drops the captured prompt', async () => {
    const target = new EventTarget()
    const handle = captureInstallPrompt(target)
    target.dispatchEvent(makeBeforeInstallPromptEvent('accepted').event)
    expect(handle.captured).toBe(true)

    handle.dispose()
    expect(handle.captured).toBe(false)
    await expect(handle.promptInstall()).resolves.toBe('unavailable')

    // Events after dispose are no longer captured.
    target.dispatchEvent(makeBeforeInstallPromptEvent('accepted').event)
    expect(handle.captured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getDisplayContext / isIosSafari
// ---------------------------------------------------------------------------

describe('getDisplayContext', () => {
  it("'pwa' when the standalone display-mode media query matches", () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)',
    }))
    vi.stubGlobal('navigator', {})
    expect(getDisplayContext()).toBe('pwa')
  })

  it("'pwa' on iOS standalone (navigator.standalone) even without matchMedia", () => {
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('navigator', { standalone: true })
    expect(getDisplayContext()).toBe('pwa')
  })

  it("'browser' when neither signal is present", () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('navigator', { standalone: false })
    expect(getDisplayContext()).toBe('browser')
  })

  it("'browser' in hosts without matchMedia or navigator hints", () => {
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('navigator', undefined)
    expect(getDisplayContext()).toBe('browser')
  })

  it("'browser' when matchMedia throws", () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no media support')
    })
    vi.stubGlobal('navigator', {})
    expect(getDisplayContext()).toBe('browser')
  })
})

describe('isIosSafari', () => {
  const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const IPHONE_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1'
  const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
  const IPAD_AS_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

  it('true on iPhone Safari', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_SAFARI })
    expect(isIosSafari()).toBe(true)
  })

  it('true on iPadOS masquerading as macOS (MacIntel + touch)', () => {
    vi.stubGlobal('navigator', {
      userAgent: IPAD_AS_MAC,
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })
    expect(isIosSafari()).toBe(true)
  })

  it('false on iPhone Chrome (CriOS)', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_CHROME })
    expect(isIosSafari()).toBe(false)
  })

  it('false on Android Chrome', () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID_CHROME })
    expect(isIosSafari()).toBe(false)
  })

  it('false on real macOS Safari (no touch points)', () => {
    vi.stubGlobal('navigator', {
      userAgent: IPAD_AS_MAC,
      platform: 'MacIntel',
      maxTouchPoints: 0,
    })
    expect(isIosSafari()).toBe(false)
  })

  it('false without a navigator', () => {
    vi.stubGlobal('navigator', undefined)
    expect(isIosSafari()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// watchOnline
// ---------------------------------------------------------------------------

describe('watchOnline', () => {
  it('reports the initial navigator.onLine state immediately', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const seen: boolean[] = []
    const stop = watchOnline((online) => seen.push(online), new EventTarget())
    expect(seen).toEqual([false])
    stop()
  })

  it('fires on online/offline transitions and stops after unsubscribe', () => {
    vi.stubGlobal('navigator', { onLine: true })
    const target = new EventTarget()
    const seen: boolean[] = []
    const stop = watchOnline((online) => seen.push(online), target)

    target.dispatchEvent(new Event('offline'))
    target.dispatchEvent(new Event('online'))
    expect(seen).toEqual([true, false, true])

    stop()
    target.dispatchEvent(new Event('offline'))
    expect(seen).toEqual([true, false, true])
  })

  it('defaults to the global window target', () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    vi.stubGlobal('navigator', { onLine: true })
    const seen: boolean[] = []
    const stop = watchOnline((online) => seen.push(online))

    target.dispatchEvent(new Event('offline'))
    expect(seen).toEqual([true, false])
    stop()
  })

  it('assumes online with a no-op unsubscribe in hosts without window/events', () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('navigator', undefined)
    const seen: boolean[] = []
    const stop = watchOnline((online) => seen.push(online))
    expect(seen).toEqual([true])
    expect(() => stop()).not.toThrow()
  })
})
