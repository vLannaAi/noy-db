/**
 * Showcase 48 — in-nextjs (cookie-session helpers)
 *
 * What you'll learn
 * ─────────────────
 * `cookieSession({ cookies })` adapts Next's `cookies()` jar to noy-db's
 * session contract: `read()`, `write({ userId, sessionToken })`,
 * `clear()`. `configureNoydb({ factory, session })` registers the
 * factory function so server-component / server-action calls to
 * `getNoydb()` resolve to a Noydb bound to the current request.
 *
 * Why it matters
 * ──────────────
 * Next.js App Router pushes auth into the cookie jar. The session
 * adapter keeps token lifecycle out of consumer code — write at sign-in,
 * read on every server call, clear at sign-out.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-nextjs
 *
 * Note: this showcase uses a synthetic NextCookieJar — no Next runtime
 * is booted. The contract is just `get`/`set`/`delete`, so any
 * cookies-like jar works.
 */

import { describe, it, expect } from 'vitest'
import { cookieSession, type NextCookieJar } from '@noy-db/in-nextjs'

function mockJar(): NextCookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get(name) {
      const value = store.get(name)
      return value !== undefined ? { name, value } : undefined
    },
    set(name, value) { store.set(name, value) },
    delete(name) { store.delete(name) },
  }
}

describe('Showcase 48 — in-nextjs', () => {
  it('cookieSession round-trips userId + sessionToken through the jar', async () => {
    const jar = mockJar()
    const session = cookieSession({ cookies: () => jar })

    expect(await session.read()).toBeNull()

    await session.write({ userId: 'alice', sessionToken: 'tok-xyz' })
    expect(await session.read()).toEqual({ userId: 'alice', sessionToken: 'tok-xyz' })

    await session.clear()
    expect(await session.read()).toBeNull()
  })
})
