/**
 * Runtime capability dump for the essential `to-*` stores (#913).
 *
 * Constructs each store the way its own conformance test does and serializes
 * the `capabilities` object it actually exposes, so the docs storage matrix is
 * runtime-verified rather than hand-typed. Runs as a vitest test — vitest
 * resolves the stores' `.js → .ts` source imports, which plain Node
 * type-stripping cannot, so `pnpm install` is the only prerequisite and no
 * `pnpm build` is needed. Writing the dump is triggered by DOCS_BRIDGE_CAPS_OUT;
 * without it this is simply a drift alarm on the four stores.
 *
 * The wiring table lives here, mirroring noy-db-to's dump.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toMemory } from '../../packages/to-memory/src/index.js'
import { toFile } from '../../packages/to-file/src/index.js'
import { toBrowserIdb } from '../../packages/to-browser-idb/src/index.js'
import { toMeter } from '../../packages/to-meter/src/index.js'

// No `indexedDB` shim: `toBrowserIdb()` builds its adapter object eagerly but
// only opens a database inside an operation, so `capabilities` is readable
// without one. Its conformance suite needs `fake-indexeddb` because it performs
// real reads and writes; this dump does not.

/**
 * `shape` vocabulary:
 *   - `record` — a storage backend exposing a real `capabilities` object.
 *   - `wrapper` — wraps another store and has no capability surface of its
 *     own (`to-meter`). Recorded as null rather than all-false: "no opinion"
 *     and "declares nothing atomic" are different claims, and a storage matrix
 *     that conflates them misinforms.
 *
 * noy-db-to additionally emits `vault` for pod stores; none of the essential
 * four is one. The docs consumer reads capabilities only when
 * `shape === 'record'`, so an unfamiliar value degrades to "no capabilities"
 * rather than breaking the sync.
 */
const WIRING: Record<string, {
  factory: string
  shape: 'record' | 'wrapper'
  optionDependent: boolean
  make: () => unknown
}> = {
  'to-browser-idb': { factory: 'toBrowserIdb', shape: 'record', optionDependent: false, make: () => toBrowserIdb({ prefix: 'docs-bridge-dump' }) },
  'to-file': { factory: 'toFile', shape: 'record', optionDependent: false, make: () => toFile({ dir: mkdtempSync(join(tmpdir(), 'docs-bridge-file-')) }) },
  'to-memory': { factory: 'toMemory', shape: 'record', optionDependent: false, make: () => toMemory() },
  'to-meter': { factory: 'toMeter', shape: 'wrapper', optionDependent: false, make: () => toMeter() },
}

describe('docs-bridge capability dump', () => {
  it('constructs the essential stores and dumps factory/shape/capabilities', () => {
    const dump: Record<string, {
      factory: string; shape: string; capabilities: object | null; optionDependent: boolean
    }> = {}

    for (const [dir, w] of Object.entries(WIRING)) {
      const store = w.make() as { capabilities?: object }
      const capabilities = w.shape === 'record' ? store.capabilities ?? null : null
      if (w.shape === 'record') {
        expect(capabilities, `${dir}: a record store must expose capabilities`).toBeTruthy()
      }
      expect(w.factory).toMatch(/^to[A-Z]/)
      dump[dir] = { factory: w.factory, shape: w.shape, capabilities, optionDependent: w.optionDependent }
    }

    // Guards the count against a store being added to packages/ without being
    // wired here — build-payload.mjs throws on the same drift from the other side.
    expect(Object.keys(dump)).toHaveLength(4)

    const out = process.env['DOCS_BRIDGE_CAPS_OUT']
    if (out) writeFileSync(out, JSON.stringify(dump, null, 2) + '\n')
  })
})
