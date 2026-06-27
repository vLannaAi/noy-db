/**
 * **@noy-db/in-nextjs** — Next.js App Router helpers for noy-db.
 *
 * Two surfaces:
 *
 *   - **Default export** (this file): **server-only** helpers that
 *     use Next's `cookies()` and `headers()` APIs. Import from
 *     `@noy-db/in-nextjs` inside server components, route handlers,
 *     and server actions.
 *
 *   - **`@noy-db/in-nextjs/client`**: re-exports of `@noy-db/in-react`
 *     hooks for client components. Import from
 *     `@noy-db/in-nextjs/client` inside any `'use client'` file.
 *
 * Keeping them in separate entry points means Next's bundler prunes
 * the server helpers out of the client bundle automatically — no
 * manual `'use server'` / `'use client'` annotations needed.
 *
 * ## Cookie-based session
 *
 * The default session store reads an opaque session token from a
 * cookie (`noydb_session` by default) and passes it to the hub. The
 * token IS NOT the vault passphrase — it's a reference token that
 * the hub resolves against its own session table. Tokens rotate on
 * every unlock and invalidate on logout.
 *
 * ```ts
 * // app/invoices/page.tsx  (server component)
 * import { getNoydb, getVault } from '@noy-db/in-nextjs'
 *
 * export default async function InvoicesPage() {
 *   const db = await getNoydb()
 *   const vault = await getVault(db, 'acme')
 *   const invoices = await vault.collection('invoices').list()
 *   return <InvoicesList items={invoices} />
 * }
 * ```
 *
 * ```ts
 * // app/api/invoices/route.ts  (route handler)
 * import { withVault } from '@noy-db/in-nextjs'
 * import { NextResponse } from 'next/server'
 *
 * export const GET = withVault('acme', async (vault) => {
 *   const invoices = await vault.collection('invoices').list()
 *   return NextResponse.json(invoices)
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { Noydb, Vault } from '@noy-db/hub'

// ─── Session-store abstraction ─────────────────────────────────────────

/**
 * Pluggable session resolver. Default implementation reads from Next's
 * `cookies()` API; consumers can swap in a header-based or memory-based
 * resolver for testing or custom auth.
 */
export interface SessionStore {
  /** Returns the user id + session token for the current request, or null when absent. */
  read(): Promise<{ userId: string; sessionToken: string } | null>
  /** Write a new session token (called on unlock or rotation). */
  write(value: { userId: string; sessionToken: string; maxAgeSeconds?: number }): Promise<void>
  /** Clear the session (called on logout). */
  clear(): Promise<void>
}

/**
 * Duck-typed `cookies()` return — we don't import from `next/headers`
 * directly so tests don't need Next's runtime.
 */
export interface NextCookieJar {
  get(name: string): { name: string; value: string } | undefined
  set(name: string, value: string, options?: { httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none'; maxAge?: number; path?: string }): void
  delete(name: string): void
}

export interface CookieSessionOptions {
  /** How to obtain Next's cookie jar. Default dynamically imports `next/headers`. */
  readonly cookies?: () => Promise<NextCookieJar> | NextCookieJar
  /** Cookie name for the session token. Default `'noydb_session'`. */
  readonly cookieName?: string
  /** Cookie name for the user id. Default `'noydb_user'`. */
  readonly userCookieName?: string
  /** Cookie maxAge in seconds. Default 1 hour. */
  readonly maxAgeSeconds?: number
}

async function defaultCookies(): Promise<NextCookieJar> {
  // Dynamic import keeps `next/headers` out of non-Next environments.
  const mod = (await import('next/headers').catch(() => null)) as
    | { cookies: () => Promise<NextCookieJar> | NextCookieJar }
    | null
  if (!mod) {
    throw new Error(
      "[@noy-db/in-nextjs] `next/headers` is unavailable. Supply a custom `cookies` resolver " +
      "in cookieSession({ cookies: () => … }) when running outside a Next.js server context.",
    )
  }
  return mod.cookies()
}

/** Build a cookie-backed session store for Next.js server contexts. */
export function cookieSession(options: CookieSessionOptions = {}): SessionStore {
  const cookieName = options.cookieName ?? 'noydb_session'
  const userCookieName = options.userCookieName ?? 'noydb_user'
  const getJar = options.cookies ?? defaultCookies
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600

  return {
    async read() {
      const jar = await Promise.resolve(getJar())
      const sessionCookie = jar.get(cookieName)
      const userCookie = jar.get(userCookieName)
      if (!sessionCookie || !userCookie) return null
      return { userId: userCookie.value, sessionToken: sessionCookie.value }
    },
    async write(value) {
      const jar = await Promise.resolve(getJar())
      const opts = {
        httpOnly: true,
        secure: true,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: value.maxAgeSeconds ?? maxAgeSeconds,
      }
      jar.set(cookieName, value.sessionToken, opts)
      jar.set(userCookieName, value.userId, opts)
    },
    async clear() {
      const jar = await Promise.resolve(getJar())
      jar.delete(cookieName)
      jar.delete(userCookieName)
    },
  }
}

// ─── Server helpers ────────────────────────────────────────────────────

/**
 * The Noydb factory contract — consumers call `setNoydbFactory()` at
 * app init with whatever store + auth wiring they prefer. The factory
 * receives the current session and returns an opened Noydb instance.
 */
export type NoydbFactory = (session: { userId: string; sessionToken: string } | null) => Promise<Noydb>

let configured: { factory: NoydbFactory; session: SessionStore } | null = null

/**
 * Configure the Next.js integration. Call once at app init (e.g. in
 * `app/layout.tsx` or a `lib/noydb.ts` module).
 */
export function configureNoydb(options: { factory: NoydbFactory; session?: SessionStore }): void {
  configured = {
    factory: options.factory,
    session: options.session ?? cookieSession(),
  }
}

function requireConfig(): NonNullable<typeof configured> {
  if (!configured) {
    throw new Error(
      "[@noy-db/in-nextjs] configureNoydb({ factory, session }) must be called before getNoydb().",
    )
  }
  return configured
}

/**
 * Server-only helper. Reads the current session from cookies, invokes
 * the configured factory, and returns an open `Noydb` instance.
 */
export async function getNoydb(): Promise<Noydb> {
  const { factory, session } = requireConfig()
  const current = await session.read()
  return factory(current)
}

/** Convenience: open a vault by name, returning the `Vault` directly. */
export async function getVault(db: Noydb, name: string): Promise<Vault> {
  return db.openVault(name)
}

/**
 * Route-handler wrapper. Opens the vault once per request and passes
 * it to your handler. The Noydb instance is closed on exit so the
 * session keys don't outlive the response.
 */
export function withVault<T extends Request, R>(
  vaultName: string,
  handler: (vault: Vault, request: T) => Promise<R>,
): (request: T) => Promise<R> {
  return async (request: T) => {
    const db = await getNoydb()
    try {
      const vault = await db.openVault(vaultName)
      return await handler(vault, request)
    } finally {
      await safeClose(db)
    }
  }
}

/**
 * Route-handler wrapper that does NOT open a vault — use when the
 * handler needs direct `Noydb` access (e.g. managing multiple vaults
 * per request).
 */
export function withNoydb<T extends Request, R>(
  handler: (db: Noydb, request: T) => Promise<R>,
): (request: T) => Promise<R> {
  return async (request: T) => {
    const db = await getNoydb()
    try {
      return await handler(db, request)
    } finally {
      await safeClose(db)
    }
  }
}

/**
 * Server action helper — write a new session on login. Called from a
 * server action that validated the user's passphrase through
 * `@noy-db/on-*` and received a session token back.
 */
export async function writeSession(value: { userId: string; sessionToken: string; maxAgeSeconds?: number }): Promise<void> {
  const { session } = requireConfig()
  await session.write(value)
}

/** Server action helper — clear the session on logout. */
export async function clearSession(): Promise<void> {
  const { session } = requireConfig()
  await session.clear()
}

/** Introspection — useful for tests. Resets the configured factory. */
export function resetNoydbConfig(): void {
  configured = null
}

/**
 * Defensively close a Noydb instance, tolerating sync + async close
 * signatures without tripping `await-thenable` lint.
 */
async function safeClose(db: Noydb): Promise<void> {
  try {
    const result: unknown = db.close()
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      await (result as Promise<unknown>)
    }
  } catch {
    // best-effort — never block the response on teardown
  }
}
