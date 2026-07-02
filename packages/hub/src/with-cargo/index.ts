/**
 * **@noy-db/hub/cargo** — the orchestration seam klum binds. Canonical
 * successor to `/kernel` (which remains as a deprecated alias).
 *
 * `cargo` is the layer of services + interfaces required to **manage pods** —
 * the multi-vault management plane klum-db binds: custody, deed, diff,
 * distributed query, addressing, and change-observation. It consolidates the
 * whole current `/kernel` runtime floor plus the orchestration delta.
 *
 * See docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md.
 *
 * @packageDocumentation
 */

// The runtime floor — the whole current /kernel surface.
export * from '../legacy/kernel.js'

// Custody & ownership.
export { CustodyApi } from '../with-party/custody/index.js'
export type { GrantCustodianOptions } from '../with-party/custody/index.js'
export { liberateVault } from '../with-party/custody/liberate.js'
export type { LiberateOptions, LiberateResult } from '../with-party/custody/liberate.js'
export { createDeedOwner, loadDeedMarker, isDeedVault } from '../with-party/team/deed.js'
export type { DeedMarker } from '../with-party/team/deed.js'
export type { SealingKeyProvider } from '../with-party/team/managed-passphrase.js'

// Interchange & addressing.
export { diffVault } from './vault-diff.js'
export { STATE_VAULT_NAME } from '../kernel/constants.js'

// Capability opt-in seam (S4): the source-side `extractPartition` free function
// routes through the cargoStrategy, so it throws CargoNotEnabledError unless
// opted in. adopt/decrypt — and `diffVault` (shared import/merge infra) — stay
// ungated host-side.
export { withCargo } from './active.js'
export { NO_CARGO } from './strategy.js'
export type { CargoStrategy } from './strategy.js'
export { CargoNotEnabledError } from '../kernel/errors.js'

// Change observation.
export type { WriteHook } from '../port/with/write-hooks.js'
export type { WriteQueue } from '../kernel/write-queue.js'
export type { WriteConflict } from '../kernel/types.js'
export type { AccessibleVault } from '../kernel/types.js'
export type { Unsubscribe } from '../kernel/types.js'
