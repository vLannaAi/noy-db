/**
 * #664a Important-adjacent fix (opus task review) — the kernel-api golden
 * (`kernel-api-surface-golden.test.ts`) only enumerates PROTOTYPE members (methods); instance
 * FIELDS never show up there. The exact #664a regression: `locale`, `i18nStrategy`,
 * `translateText`, and five registry Maps went public on `Vault` so `this` would structurally
 * satisfy `ViaReconcileVaultCtx` at the `reconcileViaAttach()` call site — a silent public-surface
 * widening no existing test caught. Fixed by re-privatizing all nine and building the ctx bag from
 * `Vault`'s privates via `Vault._viaReconcileCtx()` instead. This file is the regression guard.
 *
 * A full pinned `keyof Vault` snapshot was considered and rejected as too brittle/large to be a
 * SIMPLE guard here — `Vault` has dozens of legitimate public methods, and the snapshot would need
 * updating on every ordinary new public method, defeating its own purpose as a targeted signal.
 * Instead: a coarser, NAMED guard — each of the nine fields this exact regression touched must NOT
 * be a key of `Vault` (`expectTypeOf().not.toHaveProperty(...)`, validated by
 * `pnpm --filter @noy-db/hub typecheck` via `tsconfig.typetest.json`, mirroring this repo's other
 * `*.test-d.ts` files' use of `expectTypeOf`).
 *
 * Tradeoff (documented, not hidden): this catches exactly these nine fields resurfacing as public
 * (or being renamed and re-added public under the same name); it does NOT catch an unrelated,
 * brand-new private field being mistakenly declared public — that would need the broader (and, per
 * the review's own framing, not-simple) pinned-snapshot approach.
 */
import { describe, it, expectTypeOf } from 'vitest'
import type { Vault } from '../src/index.js'

describe('Vault — the nine #664a via-reconcile-adjacent fields stay off the public surface', () => {
  it('none of them are keys of Vault', () => {
    expectTypeOf<Vault>().not.toHaveProperty('i18nStrategy')
    expectTypeOf<Vault>().not.toHaveProperty('locale')
    expectTypeOf<Vault>().not.toHaveProperty('translateText')
    expectTypeOf<Vault>().not.toHaveProperty('i18nFieldRegistry')
    expectTypeOf<Vault>().not.toHaveProperty('dictKeyFieldRegistry')
    expectTypeOf<Vault>().not.toHaveProperty('staticByName')
    expectTypeOf<Vault>().not.toHaveProperty('staticDescriptorByField')
    expectTypeOf<Vault>().not.toHaveProperty('reservedLookupCollections')
    expectTypeOf<Vault>().not.toHaveProperty('staticDictNames')
  })
})
