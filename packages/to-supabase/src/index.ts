/**
 * **@noy-db/to-supabase** — Supabase adapter for noy-db.
 *
 * Supabase projects ship both a Postgres database and an S3-compatible
 * object store. This package is a thin factory that configures
 * `@noy-db/to-postgres` for the Postgres pool that the consumer has
 * already wired (via `@supabase/supabase-js`, node-postgres, or the
 * Supabase serverless driver) and re-exports the result.
 *
 * ## Why not embed `@supabase/supabase-js`?
 *
 * The Supabase client is a large dependency that also bundles
 * `node-fetch`, a realtime websocket, and a storage client. Embedding
 * it would duplicate transport code that the consumer has already
 * installed for their app logic. The noy-db adapter only needs the
 * Postgres query path, so we accept whatever SQL-capable client the
 * consumer passes in — same contract as `@noy-db/to-postgres`.
 *
 * ## Typical wiring
 *
 * ```ts
 * import { createClient } from '@supabase/supabase-js'
 * import { supabase } from '@noy-db/to-supabase'
 * import pg from 'pg'
 *
 * const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL })
 * const store = supabase({ client: pool })
 *
 * // Optionally, the Supabase JS client for Storage-based blob routing:
 * const s = createClient(url, key)
 * // … blob-routing helpers can be added in a v0.2 follow-up
 * ```
 *
 * ## Capabilities
 *
 * Inherits everything from `@noy-db/to-postgres`: `casAtomic: true`,
 * `txAtomic: true`, `listPage`, `ping`.
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub'
import type { PostgresClient, PostgresStoreOptions } from '@noy-db/to-postgres'
import { postgres } from '@noy-db/to-postgres'

export type { PostgresClient }

export interface SupabaseStoreOptions extends Omit<PostgresStoreOptions, 'client'> {
  /**
   * Any Postgres-compatible client — `pg.Pool`, `pg.Client`, or a
   * Supabase serverless driver. The noy-db store never talks to the
   * Supabase REST / Realtime APIs.
   */
  readonly client: PostgresClient
}

/**
 * Create a noy-db store backed by a Supabase Postgres connection.
 * Inherits the entire `@noy-db/to-postgres` feature set.
 */
export function supabase(options: SupabaseStoreOptions): NoydbStore {
  const base = postgres(options)
  return { ...base, name: 'supabase' }
}
