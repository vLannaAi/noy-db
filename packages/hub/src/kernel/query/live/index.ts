/**
 * `@noy-db/hub/query/live` — **the Live group of the query DSL.**
 *
 * ```ts
 * import '@noy-db/hub/query/live'   // once, in your app's entry
 *
 * const stop = invoices.query().where('status', '==', 'paid').subscribe(rows => render(rows))
 * ```
 *
 * ⭐ **Imported for its side effect** — it patches `subscribe` and `live` onto
 * `Query.prototype` and merges their types into `Query`. See
 * `../relate/index.ts` for the full note on why `package.json`'s `sideEffects`
 * array must keep naming this file.
 */
import type { LiveSurface } from './methods.js'
import { installLive } from './install.js'

// ⭐ The statement that makes this file an ENTRY — see `../relate/install.ts`.
installLive()

declare module '../builder.js' {
  // #1458 — the empty body is the mechanism, not an oversight. Interface
  // merging is what attaches the group's methods to the class declared in
  // `builder.ts` / `scan-builder.ts`; the members come from the `Pick` in the
  // `extends` clause, so writing any here would duplicate signatures that must
  // not be allowed to drift from the implementations.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Query<
    T,
    S extends keyof T = never,
    Q extends keyof T & string = never,
    M extends keyof T & string = never,
  > extends LiveSurface<T, S, Q, M> {}
}

export { buildLiveQuery } from './live.js'
export type { LiveQuery, LiveUpstream, LiveBuildOptions } from './live.js'
export type { SourceChange } from './incremental.js'
