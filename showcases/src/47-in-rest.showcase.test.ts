/**
 * Showcase 47 — in-rest (HTTP handler over the noy-db surface)
 *
 * What you'll learn
 * ─────────────────
 * `createRestHandler({ store, user })` returns a `handle(request)`
 * function that maps HTTP requests to the noy-db API: passphrase
 * unlock → bearer token → collection CRUD. The handler is
 * framework-free: drop it into Hono, Express, Fastify, Cloudflare
 * Workers, Bun, or a raw `Bun.serve`.
 *
 * Why it matters
 * ──────────────
 * Some deployments need a thin REST surface — mobile clients, CLI
 * tooling, partner integrations. The handler keeps the encryption
 * boundary inside the server: clients see plaintext only after they
 * authenticate and only for the records the keyring permits.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 48-in-nextjs (server-action sessions over the same surface)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-rest
 */

import { describe, it, expect } from 'vitest'
import { createRestHandler, type RestRequest } from '@noy-db/in-rest'
import { memory } from '@noy-db/to-memory'

function req(method: string, pathname: string, body?: unknown, token?: string): RestRequest {
  return {
    method,
    pathname,
    searchParams: new URLSearchParams(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    json: () => Promise.resolve(body ?? null),
  }
}

describe('Showcase 47 — in-rest', () => {
  it('passphrase unlock returns a session token usable for further requests', async () => {
    const handler = createRestHandler({ store: memory(), user: 'alice' })

    const unlock = await handler.handle(req('POST', '/sessions/unlock/passphrase', {
      passphrase: 'in-rest-pass-2026',
    }))
    expect(unlock.status).toBe(200)
    const { token } = JSON.parse(unlock.body as string) as { token: string }
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(10)

    // Without the token, /sessions/current reports inactive.
    const anon = await handler.handle(req('GET', '/sessions/current'))
    const anonBody = JSON.parse(anon.body as string) as { active: boolean }
    expect(anonBody.active).toBe(false)

    // With the token, the same endpoint reports active.
    const authed = await handler.handle(req('GET', '/sessions/current', undefined, token))
    const authedBody = JSON.parse(authed.body as string) as { active: boolean }
    expect(authedBody.active).toBe(true)
  })
})
