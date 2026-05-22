/**
 * Derive a {@link PersistedSchemaEnvelope} from a Standard Schema v1
 * validator. v0 supports Zod via `zod-to-json-schema` (optional peer-dep);
 * other families write a stub envelope flagging the kind.
 *
 * @see docs/superpowers/specs/2026-05-22-schema-dump-design.md
 *
 * @module
 */

import { canonicalize } from './canonicalize.js'
import { sha256Hex } from '../crypto.js'
import type { PersistedSchemaEnvelope, PersistedSchemaKind } from './types.js'

/**
 * Heuristic Zod detection — Zod schemas carry a `_def.typeName` property
 * starting with `Zod` (e.g. `ZodObject`, `ZodString`). This survives Zod's
 * minor-version bumps because the typeName naming is stable across v3.
 */
export function isZodSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const def = (value as { _def?: { typeName?: unknown } })._def
  if (!def || typeof def !== 'object') return false
  return typeof def.typeName === 'string' && def.typeName.startsWith('Zod')
}

function detectKind(validator: unknown): PersistedSchemaKind {
  if (isZodSchema(validator)) return 'Zod'
  return 'Unknown'
}

/**
 * Lazy-require `zod-to-json-schema`. Returns the converter, or throws a
 * clear error if the peer-dep isn't installed.
 */
async function loadZodConverter(): Promise<(s: unknown) => object> {
  try {
    const mod = (await import('zod-to-json-schema')) as { zodToJsonSchema?: (s: unknown) => object }
    if (!mod.zodToJsonSchema) {
      throw new Error('zod-to-json-schema export missing')
    }
    return mod.zodToJsonSchema
  } catch (err) {
    throw new Error(
      'persistJsonSchema requires the optional peer-dep `zod-to-json-schema`. '
      + 'Install it: `pnpm add zod-to-json-schema` (or npm/yarn equivalent). '
      + `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function derivePersistedSchema(
  validator: unknown,
): Promise<PersistedSchemaEnvelope> {
  const kind = detectKind(validator)
  const derivedAt = new Date().toISOString()

  if (kind === 'Zod') {
    const convert = await loadZodConverter()
    const jsonSchema = convert(validator)
    const canonical = canonicalize(jsonSchema)
    const hash = await sha256Hex(new TextEncoder().encode(canonical))
    return { _noydb_schema: 1, kind, jsonSchema, hash, derivedAt }
  }

  return {
    _noydb_schema: 1,
    kind,
    jsonSchema: null,
    hash: null,
    reason: `derivation not yet supported for kind=${kind} (v0 supports Zod only)`,
    derivedAt,
  }
}
