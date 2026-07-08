/**
 * Escape hatch: `proxied[RAW_TARGET]` returns the unwrapped collection — no
 * existence check, no pair lock, no fan-out. Needed by callers (`fanout.ts`,
 * a proxy's own internals) that already hold the pair mutex themselves;
 * going back through a proxy's `put`/`delete` would re-enter
 * `registry.withPairLock` on the same base and deadlock (non-reentrant —
 * see `registry.ts:withPairLock`) or recurse forever (the base proxy's
 * `delete` calls `pairDelete`, which must not call back into it).
 *
 * Lives in its own module (not `proxy.ts`) so `fanout.ts` can import it
 * without creating a `proxy.ts` ⇄ `fanout.ts` import cycle — `proxy.ts`
 * imports `pairDelete` from `fanout.ts` for `makeBaseProxy`.
 */
export const RAW_TARGET: unique symbol = Symbol('noydb.satellite.rawTarget')
