/**
 * #1458 — the Relate install, as a FUNCTION rather than a module side effect.
 *
 * ⛔ **This shape is load-bearing and was arrived at by measurement.** The
 * install used to be a top-level statement in `./index.ts`. `./index.ts` was
 * then reachable from two build entries — its own subpath AND the root barrel —
 * so esbuild's code-splitting moved its module body into a SHARED CHUNK, and
 * the built `dist/query/relate/index.js` became nothing but a list of chunk
 * imports. `package.json`'s `sideEffects` names the entry file; it cannot name
 * a hash-named chunk. So a consumer's bundler saw a side-effect-free bare
 * import and dropped it — `import '@noy-db/hub/query/relate'` compiled, shipped,
 * and installed nothing.
 *
 * ⭐ Measured, not theorised: the three control scenarios in
 * `scripts/check-bundle.mjs` reported all three groups byte-identical to
 * Find-only, and `MISSING:function reducerBuilder — the side-effect import did
 * not bring it`. That is the whole reason those controls exist.
 *
 * Keeping the CALL in `./index.ts` and the WORK here means the entry file has a
 * statement of its own, so it stays an entry rather than dissolving into
 * chunks. The root barrel calls this function directly, from its own module
 * body, for the same reason.
 */
import { Query } from '../builder.js'
import { ScanBuilder } from '../scan-builder.js'
import { installMethods } from '../internal/core.js'
import { installRelateHooks } from '../internal/hooks.js'
import { RelateMethods, applyCrossJoin } from './methods.js'
import { ScanRelateMethods } from './scan-methods.js'
import { applyJoins, joinsDropLeftRows, orderReferencesJoinAlias, splitAroundJoins } from './join.js'

let done = false

/** Idempotent: the root barrel and the subpath entry both call it. */
export function installRelate(): void {
  if (done) return
  done = true
  installMethods(Query.prototype, RelateMethods)
  installMethods(ScanBuilder.prototype, ScanRelateMethods)
  installRelateHooks({
    applyJoins,
    splitAroundJoins,
    orderReferencesJoinAlias,
    joinsDropLeftRows,
    applyCrossJoin,
  })
}
