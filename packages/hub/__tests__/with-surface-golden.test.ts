/**
 * Golden export-surface freeze for the `@noy-db/hub/with` seam (S5 family doors).
 *
 * `/with` is the seam every `with*()` opt-in service hooks into: the
 * `ServiceBus` (observe/gate lifecycle bus, renamed from `SubsystemBus`),
 * the `WriteHookRegistry`, and the export/import capability gate. It was
 * assembled from three loose top-level `kernel/*.ts` files. This test
 * freezes its export list against a checked-in baseline
 * (`with-surface.golden.json`) so drift fails CI — adding requires a visible
 * baseline update, removing / renaming fails loudly.
 *
 * MECHANISM — identical to the `/to` golden test (see its header for the
 * rationale): runtime `Object.keys` freezes the VALUE exports (classes,
 * functions, and the `SubsystemBus` deprecated const alias); a source-parse
 * of the `export type { … } from` blocks freezes the TYPE-only exports
 * (erased at runtime); a compile-time `import type` list asserts every
 * baselined type still resolves so a removal also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as withDoor from '../src/port/with/index.js'
import type {
  BusHandler, GateDeleteEvent, GateEventMap, GateHandler, GatePoint, GatePutEvent,
  LifecycleEventMap, LifecyclePoint, SubsystemBus, Unsubscribe, WriteEvent, WriteHook,
} from '../src/port/with/index.js'

interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
}

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
}

/**
 * `SubsystemBus` is a DUAL export: `kernel/with/service-bus.ts` declares
 * both a deprecated value alias (`export const SubsystemBus = ServiceBus`)
 * and a deprecated type alias (`export type SubsystemBus = ServiceBus`)
 * under the same name, and the barrel re-exports both through the single
 * VALUE-style `export { ServiceBus, SubsystemBus } from './service-bus.js'`
 * clause — there is no separate `export type { SubsystemBus }` clause for
 * the source-parse below to see. List it here so the type half stays
 * drift-protected even though it never appears in an `export type {}` block.
 */
const DUAL_VALUE_AND_TYPE_EXPORTS = ['SubsystemBus']

/** Strip comments, then collect names from `export [type] { … } from` blocks. */
function parseExports(src: string): { values: string[]; types: string[] } {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const collect = (re: RegExp): string[] => {
    const out = new Set<string>()
    for (const m of clean.matchAll(re)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) out.add(name)
      }
    }
    return [...out].sort()
  }
  const types = collect(/export\s+type\s*\{([^}]*)\}\s*from/g)
  for (const name of DUAL_VALUE_AND_TYPE_EXPORTS) if (!types.includes(name)) types.push(name)
  return {
    types: types.sort(),
    values: collect(/export\s*\{([^}]*)\}\s*from/g),
  }
}

const baseline: Surface = JSON.parse(read('./with-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/port/with/index.ts'))

describe('@noy-db/hub/with — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(withDoor)
      .filter((k) => (withDoor as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })
})

// Compile-time exhaustiveness: every baselined type must still be exported.
type _FrozenTypes = [
  BusHandler<'afterPut'>, GateDeleteEvent, GateEventMap, GateHandler<'beforePut'>, GatePoint, GatePutEvent,
  LifecycleEventMap, LifecyclePoint, SubsystemBus, Unsubscribe, WriteEvent, WriteHook,
]
