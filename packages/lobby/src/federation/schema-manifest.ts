/**
 * @category capability
 * StateManagement Vault — schema blueprint capture + deterministic
 * fingerprint. See
 * docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md.
 */
import type { Vault } from '@noy-db/hub/kernel'
import type { IndexDef } from '@noy-db/hub/kernel'
import { sha256Hex } from '@noy-db/hub/kernel'
import type { CapturedBlueprint } from './types.js'

interface RecordedCollection {
  name: string
  indexes: IndexDef[]
  persistJsonSchema: boolean
}

/**
 * Run `configure` against a recording proxy that intercepts
 * `collection(name, opts)` calls and captures the declared blueprint.
 * The proxy delegates every other access to a no-op stub so unrelated
 * `configure` calls (guards, blob setup) do not throw — only the
 * declared collections/indexes feed the fingerprint.
 */
export function captureBlueprint(configure: (vault: Vault) => void): CapturedBlueprint {
  const recorded: RecordedCollection[] = []
  // Minimal chainable stub returned by intercepted collection() — supports
  // the fluent calls a template might make without affecting the blueprint.
  const collectionStub = new Proxy(
    {},
    {
      get: () => () => collectionStub,
    },
  )
  const proxy = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'collection') {
          return (name: string, opts?: { indexes?: IndexDef[]; persistJsonSchema?: boolean }) => {
            recorded.push({
              name,
              indexes: opts?.indexes ?? [],
              persistJsonSchema: !!opts?.persistJsonSchema,
            })
            return collectionStub
          }
        }
        // Any other vault method/property: a no-op callable that returns the proxy.
        return () => proxy
      },
    },
  ) as unknown as Vault

  configure(proxy)

  const sorted = [...recorded].sort((a, b) => a.name.localeCompare(b.name))
  const indexes: Record<string, IndexDef[]> = {}
  const persistJsonSchema: string[] = []
  for (const c of sorted) {
    indexes[c.name] = c.indexes
    if (c.persistJsonSchema) persistJsonSchema.push(c.name)
  }
  return {
    // `persistJsonSchema` is already name-sorted: it is populated while
    // iterating `sorted` (collections in name order).
    collections: sorted.map((c) => c.name),
    indexes,
    persistJsonSchema,
  }
}

/** Canonical JSON: object keys sorted recursively so the bytes are stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** sha256 (hex) over the canonicalized serializable blueprint. Uses the shared hub helper. */
export async function fingerprintBlueprint(bp: CapturedBlueprint): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonical(bp)))
}
