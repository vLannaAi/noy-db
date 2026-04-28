/**
 * SDK-backed implementation of the duck-typed `D1Database` contract
 * that `@noy-db/to-cloudflare-d1` accepts. Wraps the official
 * `cloudflare` npm package's `client.d1.database.query()` call —
 * same wire path as a hand-rolled REST POST to
 * `api.cloudflare.com/.../d1/database/{id}/query`, but with typed
 * responses, Cloudflare-maintained error classes, and forward-
 * compatibility against API surface changes.
 *
 * The previous incarnation of this file (`_d1-rest.ts`) used `fetch`
 * directly. Either implementation works against the store; the SDK
 * version is the recommended default for production-shaped code.
 *
 * Usage requires the `// @vitest-environment node` directive at the
 * top of the test file, same as the REST version — the SDK's
 * underlying transport eventually calls `fetch`, which happy-dom
 * will block under same-origin policy.
 *
 * @module
 */

import Cloudflare from 'cloudflare'
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from '@noy-db/to-cloudflare-d1'

export interface SdkD1Options {
  readonly accountId: string
  readonly databaseId: string
  readonly apiToken: string
}

/**
 * Build a `D1Database`-shaped object backed by the official
 * `cloudflare` SDK. Pass the result to `d1({ db })` exactly as you
 * would `env.DB` inside a Worker.
 */
export function sdkD1(opts: SdkD1Options): D1Database {
  const client = new Cloudflare({ apiToken: opts.apiToken })

  async function exec(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ results: Record<string, unknown>[] }> {
    // The SDK's TypeScript types declare `params: Array<string>`, which
    // is stricter than the wire reality — D1 accepts JSON-serializable
    // values (numbers, null, etc.) and the SDK passes them through
    // untouched. Cast through `unknown` to avoid stringifying numbers
    // (which would change the SQL semantics).
    const page = await client.d1.database.query(opts.databaseId, {
      account_id: opts.accountId,
      sql,
      params: params as unknown as string[],
    })

    // The query response is paginated — for single-statement queries
    // (the only kind the store issues), the first iteration carries
    // the result rows. The store never sends multi-statement SQL.
    for await (const r of page) {
      return { results: (r.results ?? []) as Record<string, unknown>[] }
    }
    return { results: [] }
  }

  function makeStatement(sql: string, params: readonly unknown[] = []): D1PreparedStatement {
    return {
      bind(...args) {
        return makeStatement(sql, args)
      },
      async first<T = unknown>(): Promise<T | null> {
        const r = await exec(sql, params)
        return (r.results[0] as T | undefined) ?? null
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const r = await exec(sql, params)
        return { results: r.results as readonly T[], success: true }
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        const r = await exec(sql, params)
        return { results: r.results as readonly T[], success: true }
      },
    }
  }

  return {
    prepare: (sql: string) => makeStatement(sql),
    async batch<T = unknown>(
      statements: readonly D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      // Sequential per-statement run is correct for the store's
      // current call sites (independent DDL on saveAll). Switch to
      // the SDK's native batch endpoint when a future call site needs
      // shared transactional state across statements.
      const out: D1Result<T>[] = []
      for (const s of statements) {
        out.push(await s.run<T>())
      }
      return out
    },
  }
}
