/**
 * The ② capability seam for classified read-egress ops (stage 1: reveal;
 * stage 2: verify). `ClassifiedStrategy` + `ClassifiedRevealCtx` +
 * `ClassifiedVerifyCtx` + `NO_CLASSIFIED` now live on the kernel port
 * (`port/with/classified-strategy.ts`, #629 Task 5) — re-exported here for
 * compat with existing importers of this module.
 *
 * @internal
 */

export type { ClassifiedStrategy, ClassifiedRevealCtx, ClassifiedVerifyCtx, ClassifiedVerdict } from '../../port/with/classified-strategy.js'
export { NO_CLASSIFIED } from '../../port/with/classified-strategy.js'
