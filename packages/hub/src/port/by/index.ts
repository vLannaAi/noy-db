/**
 * `@noy-db/hub/by` — the mesh port for `by-*` session-share transports.
 *
 * A `by-*` transport (`by-tabs`, `by-peer`) binds ONLY to this subpath: the
 * drain-barrier contract for the schema-fence cutover — who is live, and what
 * generation are they on. `@klum-db/lobby` drives the same port through the
 * `Noydb` handle (`db.mesh`) without ever naming a `by-*` package.
 *
 * `StoreMesh` — the store-polling default — lives in
 * `with-shape/schema-update`, its only consumer, and is intentionally NOT
 * exported here. That is a real cost, recorded rather than worked around: it
 * is hub's own implementation of this port and the one most consumers actually
 * run, and because it is not on the published surface,
 * `@noy-db/test-mesh-conformance` cannot import it. **A port's in-hub default
 * is coverable by its published kit only if it is on the published surface.**
 *
 * ## Why this subpath exists again
 *
 * It shipped in 0.3.0 and was pruned in 0.4.0 for "zero importers" — correct at
 * the time, because it was a second place to find types that were already on
 * the root barrel. It returns in the 0.7 line because something now stands
 * behind it: the contract is published as an executable suite, and two
 * transports implement it. Ports first, then seams.
 *
 * ⚠️ That last sentence was FALSE when this seam first shipped (#1171).
 * `by-peer`, `by-tabs` and the conformance kit all imported `NoydbMesh` from
 * `@noy-db/hub/cargo`, so `/by` was republished with **zero binders** — the
 * exact condition it was pruned for — while this comment claimed otherwise. A
 * subpath resolves whether or not anyone imports it, so nothing was red. The
 * three were migrated, and `family-port-has-binder` in check-architecture.mjs
 * now asks the question on every run rather than trusting the sentence.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit
 * and tsup's per-entry bundling keeps class identity stable across subpaths.
 * Everything here also remains on `/cargo`, which is where the 0.4 codemod row
 * sends a consumer — this is additive, and that row stays true.
 */
export { isQuorum, runDrainBarrier } from './types.js'
export type {
  NoydbMesh,
  WriterPresence,
  FenceState,
  DrainBarrierOptions,
} from './types.js'
