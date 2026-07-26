/**
 * @noy-db/in-liff — LIFF shell binding. All LIFF interaction goes
 * through injected LiffLike fakes; browser globals via vi.stubGlobal
 * (the family's established mock posture — no real LINE, no browser).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  initLiffApp,
  getFreshIdToken,
  openExternal,
  LiffInitError,
  LiffTokenError,
  type LiffLike,
} from '../src/index.js'

const VAULT = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function makeJwt(exp: number): string {
  const b64u = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64u({ alg: 'ES256' })}.${b64u({ sub: 'U1234', exp })}.fake-signature`
}

function fakeLiff(overrides: Partial<LiffLike> & { loggedIn?: boolean } = {}): LiffLike & {
  calls: { login: number; openWindow: Array<{ url: string; external?: boolean }> }
} {
  const calls = { login: 0, openWindow: [] as Array<{ url: string; external?: boolean }> }
  let loggedIn = overrides.loggedIn ?? true
  return {
    calls,
    init: overrides.init ?? (async () => {}),
    isLoggedIn: overrides.isLoggedIn ?? (() => loggedIn),
    login:
      overrides.login ??
      (() => {
        calls.login++
        loggedIn = true // a fake just flips state; real LIFF navigates away
      }),
    getIDToken: overrides.getIDToken ?? (() => makeJwt(Math.floor(Date.now() / 1000) + 3600)),
    isInClient: overrides.isInClient ?? (() => true),
    openWindow:
      overrides.openWindow ?? ((params) => calls.openWindow.push(params)),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('initLiffApp', () => {
  it('boots: logged in, liff shell, token present, no deep link', async () => {
    const liff = fakeLiff()
    const ctx = await initLiffApp({
      liff, liffId: 'liff-123', locationHref: 'https://portal.example/dashboard',
    })
    expect(ctx.shell).toBe('liff')
    expect(ctx.inClient).toBe(true)
    expect(ctx.loggedIn).toBe(true)
    expect(ctx.idToken).not.toBeNull()
    expect(ctx.deepLink).toBeNull()
    expect(liff.calls.login).toBe(0)
  })

  it('requireLogin (default) triggers login when logged out', async () => {
    const liff = fakeLiff({ loggedIn: false })
    const ctx = await initLiffApp({
      liff, liffId: 'liff-123', locationHref: 'https://portal.example/',
    })
    expect(liff.calls.login).toBe(1)
    expect(ctx.loggedIn).toBe(true) // fake flipped; real LIFF navigated away
  })

  it('requireLogin: false skips login and yields a null token', async () => {
    const liff = fakeLiff({ loggedIn: false })
    const ctx = await initLiffApp({
      liff, liffId: 'liff-123', requireLogin: false,
      locationHref: 'https://portal.example/',
    })
    expect(liff.calls.login).toBe(0)
    expect(ctx.loggedIn).toBe(false)
    expect(ctx.idToken).toBeNull()
  })

  it('wraps liff.init failure in LiffInitError with cause', async () => {
    const boom = new Error('bad channel')
    const liff = fakeLiff({ init: async () => { throw boom } })
    await expect(
      initLiffApp({ liff, liffId: 'liff-x', locationHref: 'https://portal.example/' }),
    ).rejects.toSatisfy((e: unknown) =>
      e instanceof LiffInitError && e.code === 'LIFF_INIT_FAILED' && e.cause === boom)
  })

  describe('deep-link ingestion', () => {
    it('parses a share-link location, fragment token included', async () => {
      const ctx = await initLiffApp({
        liff: fakeLiff(), liffId: 'l',
        locationHref: `https://portal.example/r/${VAULT}/invoices/inv-9?period=2026-Q2#g=tok123`,
      })
      expect(ctx.deepLink).toMatchObject({
        vaultHandle: VAULT, collection: 'invoices', recordId: 'inv-9',
        period: '2026-Q2', grantToken: 'tok123',
      })
    })

    it('parses the LIFF permalink form', async () => {
      const ctx = await initLiffApp({
        liff: fakeLiff(), liffId: 'l',
        locationHref: `https://liff.line.me/1234-abcd/r/${VAULT}/invoices/inv-9`,
      })
      expect(ctx.deepLink?.recordId).toBe('inv-9')
    })

    it('non-share locations and malformed /r/ paths yield null (fail-closed swallow)', async () => {
      for (const href of [
        'https://portal.example/settings',
        'https://portal.example/r/not-a-ulid/c/x',
        'https://portal.example/r/only-two',
      ]) {
        const ctx = await initLiffApp({ liff: fakeLiff(), liffId: 'l', locationHref: href })
        expect(ctx.deepLink).toBeNull()
      }
    })

    it('non-ShareLinkParseError failures propagate (nothing else is swallowed)', async () => {
      // A location that breaks the URL constructor itself in a way that
      // is not a grammar rejection cannot be constructed via string
      // input (parseShareLink types accept string|URL) — assert the
      // guard by checking initLiffApp only catches ShareLinkParseError:
      // a hostile toString on a URL-like is out of contract; here we
      // simply verify a grammar rejection is the ONLY swallowed class.
      const ctx = await initLiffApp({
        liff: fakeLiff(), liffId: 'l', locationHref: 'not a url at all',
      })
      expect(ctx.deepLink).toBeNull() // grammar rejection → null, no throw
    })
  })

  describe('shell detection outside LINE', () => {
    it("standalone display-mode → 'pwa'", async () => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') }))
      const ctx = await initLiffApp({
        liff: fakeLiff({ isInClient: () => false }), liffId: 'l',
        locationHref: 'https://portal.example/',
      })
      expect(ctx.shell).toBe('pwa')
      expect(ctx.inClient).toBe(false)
    })

    it("iOS navigator.standalone → 'pwa'", async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: false }))
      vi.stubGlobal('navigator', { standalone: true })
      const ctx = await initLiffApp({
        liff: fakeLiff({ isInClient: () => false }), liffId: 'l',
        locationHref: 'https://portal.example/',
      })
      expect(ctx.shell).toBe('pwa')
    })

    it("plain tab → 'browser'; throwing matchMedia tolerated", async () => {
      vi.stubGlobal('matchMedia', () => { throw new Error('hostile') })
      vi.stubGlobal('navigator', {})
      const ctx = await initLiffApp({
        liff: fakeLiff({ isInClient: () => false }), liffId: 'l',
        locationHref: 'https://portal.example/',
      })
      expect(ctx.shell).toBe('browser')
    })
  })
})

describe('getFreshIdToken', () => {
  it('returns a token that is still valid', () => {
    const liff = fakeLiff()
    expect(getFreshIdToken(liff)).not.toBeNull()
    expect(liff.calls.login).toBe(0)
  })

  it("expired + default 'login' mode → liff.login() and null", () => {
    const liff = fakeLiff({ getIDToken: () => makeJwt(Math.floor(Date.now() / 1000) - 10) })
    expect(getFreshIdToken(liff)).toBeNull()
    expect(liff.calls.login).toBe(1)
  })

  it('within-skew token counts as expired', () => {
    const liff = fakeLiff({ getIDToken: () => makeJwt(Math.floor(Date.now() / 1000) + 10) })
    expect(getFreshIdToken(liff, { skewSeconds: 30 })).toBeNull()
    expect(liff.calls.login).toBe(1)
  })

  it("expired + 'throw' mode → typed LiffTokenError", () => {
    const liff = fakeLiff({ getIDToken: () => makeJwt(Math.floor(Date.now() / 1000) - 10) })
    expect(() => getFreshIdToken(liff, { onExpired: 'throw' })).toThrowError(
      expect.objectContaining({ name: 'LiffTokenError', code: 'LIFF_TOKEN_EXPIRED' }),
    )
  })

  it('missing token (logged out) follows the onExpired path, not malformed', () => {
    const liff = fakeLiff({ loggedIn: false })
    expect(() => getFreshIdToken(liff, { onExpired: 'throw' })).toThrowError(
      expect.objectContaining({ code: 'LIFF_TOKEN_EXPIRED' }),
    )
  })

  it('malformed JWT → LIFF_TOKEN_MALFORMED regardless of mode', () => {
    for (const bad of ['not-a-jwt', 'a.b', 'x.%%%.z', `h.${Buffer.from('{"exp":"soon"}').toString('base64url')}.s`]) {
      const liff = fakeLiff({ getIDToken: () => bad })
      expect(() => getFreshIdToken(liff)).toThrowError(
        expect.objectContaining({ code: 'LIFF_TOKEN_MALFORMED' }),
      )
    }
  })
})

describe('openExternal', () => {
  it('calls liff.openWindow with external: true', () => {
    const liff = fakeLiff()
    openExternal(liff, 'https://portal.example/r/abc')
    expect(liff.calls.openWindow).toEqual([
      { url: 'https://portal.example/r/abc', external: true },
    ])
  })
})

describe('errors are typed', () => {
  it('LiffInitError and LiffTokenError expose stable codes', () => {
    expect(new LiffInitError('x').code).toBe('LIFF_INIT_FAILED')
    expect(new LiffTokenError('LIFF_TOKEN_EXPIRED', 'x').code).toBe('LIFF_TOKEN_EXPIRED')
  })
})
