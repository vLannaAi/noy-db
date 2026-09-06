/**
 * `Query` with every group attached — the root barrel's view of the DSL (#1458).
 *
 * ⭐ **THE FILE EXISTS TO GET THE INSTALL'S LIFETIME RIGHT, and the two obvious
 * alternatives are both wrong in a way that was measured rather than argued:**
 *
 *   - **Installing from `src/index.ts`'s own body** makes the three groups
 *     unconditionally reachable from `createNoydb`. The `floor` scenario —
 *     `import { createNoydb }` and nothing else — went from 554 to 11,330
 *     gzipped bytes, because a consumer who never writes a query now carries
 *     the whole DSL. That is a 20× regression on the package's smallest
 *     documented consumer.
 *   - **Re-exporting the group barrels and relying on the bare import** lets a
 *     bundler drop the import as side-effect-free when the re-exported values
 *     are unused — so `collection.query().join()` throws
 *     `QueryExtensionMissingError` in a production build, for a consumer who
 *     never opted out of anything.
 *
 * This module resolves both: it EXPORTS `Query`, and it INSTALLS as a top-level
 * side effect. A bundler may drop the module when nothing uses its exports (the
 * floor consumer never names `Query`, so nothing is paid), and the moment
 * anything does use `Query`, the module is retained and the installs run with
 * it. The dependency the install needs — "attached whenever Query is reachable"
 * — is exactly the dependency an export creates.
 *
 * ⚠️ Do not add this file to `package.json`'s `sideEffects` array. Being
 * DROPPABLE is the mechanism; listing it would pin the whole DSL into every
 * bundle and restore the first failure above.
 */
import { installRelate } from './relate/install.js'
import { installReduce } from './reduce/install.js'
import { installLive } from './live/install.js'

installRelate()
installReduce()
installLive()

// ⛔ RE-BOUND, not re-exported, and the difference decides whether any of this
// works. `export { Query } from './builder.js'` is a pure re-export, so
// esbuild resolves the binding straight to `builder.js` and this module's
// chunk is left imported for its side effect ALONE — which `sideEffects:
// false` then licenses the consumer's bundler to drop. Measured: it did, with
// the warning `Ignoring this import because "dist/chunk-….js" was marked as
// having no side effects`, and the root-barrel scenario came back with no join
// code at all. Binding through a `const` gives `dist/index.js` a real named
// import from this chunk, so the chunk is retained exactly when `Query` is
// used — and dropped, with the installs, when it is not.
import { Query as FindQuery, executePlan as findExecutePlan } from './builder.js'
import { ScanBuilder as FindScanBuilder } from './scan-builder.js'

export const Query = FindQuery
export const ScanBuilder = FindScanBuilder
export const executePlan = findExecutePlan

// The value above is the class; these keep the TYPE spelling `Query<Invoice>`
// working for a consumer importing from the root barrel, and they resolve to
// the same declaration the group augmentations merge into.
export type Query<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> = FindQuery<T, S, Q, M>
export type ScanBuilder<T, S extends keyof T = never, M extends keyof T & string = never> =
  FindScanBuilder<T, S, M>
