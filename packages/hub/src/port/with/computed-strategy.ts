/**
 * computed strategy seam (#638 Task 7 — mirrors `port/with/{classified,blob}-strategy.ts`).
 * Lives on the `/with` port (the one seam the kernel spine may import statically) so
 * `kernel/via/compose.ts`/`kernel/collection-config.ts` can read a `via(computed(...))`
 * descriptor's shape without a spine→`src/via/**` static import (via-layering, Check 14).
 *
 * Installs the computed via-binder EAGERLY — the classified/blob precedent, not money/
 * i18n's lazy-in-factory pattern: a `computed: { field: { fn, deps, mode: 'virtual' } }`
 * sugar entry never calls the `computed()` declaration factory at all, so lazy linking
 * (money/i18n's `installViaBinder` call inside their own factory) would leave
 * `viaBinder('computed')` unresolved for that path. This port module is already
 * unconditionally imported by the kernel spine (`collection-config.ts`), so linking here
 * guarantees the binder is installed before `compileVias` ever needs it, regardless
 * of which surface (sugar object-form or `via(computed(...))`) declared the virtual field.
 *
 * @internal
 */
import type { ComputedDescriptor } from '../../via/computed/descriptor.js'
import { linkComputedVia } from '../../via/computed/binding.js'

export type { ComputedDescriptor }

linkComputedVia()
