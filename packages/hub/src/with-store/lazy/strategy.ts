/**
 * Service-side shim for the lazy strategy seam (#267). The contract itself
 * lives on the `/with` port (`src/port/with/lazy-strategy.ts`) so the
 * kernel spine can hold the back-compat default without a spine→service
 * static import (the port-layering rule). This file keeps the conventional
 * `<service>/{strategy,active,index}.ts` layout.
 * @internal
 */
export { IMPLICIT_LAZY, buildLazyCache, type LazyStrategy } from '../../port/with/lazy-strategy.js'
