/**
 * Derive a {@link PersistedSchemaEnvelope} from a Standard Schema v1
 * validator. Supports zod 3 (via the optional `zod-to-json-schema` peer-dep)
 * and zod 4 (via its native `z.toJSONSchema()`); both are loaded lazily so
 * hub never statically imports zod. Other validator families write a stub
 * envelope flagging the kind.
 *
 * @see design-history/2026-05-22-schema-dump-design.md
 *
 * @module
 */

import { canonicalize } from './canonicalize.js'
import { sha256Hex } from '../../kernel/enclave/index.js'
import type { PersistedSchemaEnvelope, PersistedSchemaKind } from './types.js'

/**
 * Heuristic Zod detection — uses the Standard Schema v1 `~standard.vendor`
 * property (present in Zod v3.23+ and Zod v4+). Falls back to the
 * `_def.typeName` heuristic for older Zod v3 builds that predate Standard
 * Schema support.
 */
export function isZodSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  // Standard Schema v1 vendor tag — most reliable across Zod majors
  const std = (value as { '~standard'?: { vendor?: unknown } })['~standard']
  if (std && typeof std === 'object' && (std as { vendor?: unknown }).vendor === 'zod') return true
  // Zod v3 fallback: _def.typeName starts with 'Zod' (e.g. 'ZodObject')
  const def = (value as { _def?: { typeName?: unknown } })._def
  if (!def || typeof def !== 'object') return false
  return typeof (def as { typeName?: unknown }).typeName === 'string'
    && ((def as { typeName: string }).typeName).startsWith('Zod')
}

function detectKind(validator: unknown): PersistedSchemaKind {
  if (isZodSchema(validator)) return 'Zod'
  return 'Unknown'
}

/**
 * Returns `true` when the validator was created with the Zod v4 native API
 * (i.e. `import { z } from 'zod'` where zod resolves to v4). Zod v4 native
 * schemas carry a `_zod` property whereas Zod v3 schemas (and the v3-compat
 * shim shipped inside zod@4 at `zod/v3`) use `_def.typeName`.
 *
 * Kept duck-typed so hub never statically imports zod.
 */
export function isZod4Schema(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  return '_zod' in value
}

/**
 * Lazy-require `zod-to-json-schema`. Returns the converter, or throws a
 * clear error if the peer-dep isn't installed.
 */
async function loadZodToJsonSchemaConverter(): Promise<(s: unknown) => object> {
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

/**
 * Lazy-require Zod v4's built-in `toJSONSchema`. Used when the validator is a
 * Zod v4 native schema and `zod-to-json-schema` is absent or cannot handle it.
 *
 * Dynamic so hub never loads zod unless a caller actually persists a Zod v4
 * schema. ⚠️ Dynamic is NOT what keeps zod out of the tarball — that is
 * `peerDependencies` (#1227). tsup externalises DECLARED dependencies and
 * BUNDLES everything else, static or dynamic alike, so while zod was a
 * devDependency only, this line silently vendored 548 KB of zod@4.4.3 into
 * `dist/` at a build-frozen version. The comment here previously claimed the
 * dynamic import was what prevented that; it never did.
 *
 * Declaring it an OPTIONAL peer is also the correctness fix, not just a size
 * one: `toJSONSchema` reads a schema's internals, and the schema is built by
 * the CONSUMER's zod. A vendored copy meant hub inspected one zod's objects
 * with another zod's version of that reader. Now there is one zod — theirs.
 */
async function loadZodV4Converter(): Promise<(s: unknown) => object> {
  try {
    const mod = (await import('zod')) as { toJSONSchema?: (s: unknown) => object }
    if (typeof mod.toJSONSchema !== 'function') {
      throw new Error('zod.toJSONSchema not available (zod v4 required)')
    }
    return mod.toJSONSchema
  } catch (err) {
    throw new Error(
      'persistJsonSchema with a Zod v4 schema requires zod@4 with toJSONSchema. '
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
    let jsonSchema: object

    if (isZod4Schema(validator)) {
      // Zod v4 native schemas: use zod's built-in toJSONSchema (available in
      // zod@4) because zod-to-json-schema@3.x parses _def.typeName which is
      // absent in native v4 schemas.
      const convert = await loadZodV4Converter()
      jsonSchema = convert(validator)
    } else {
      // Zod v3 schemas (or v3-compat shim): use the optional peer-dep
      // zod-to-json-schema for backward compatibility.
      const convert = await loadZodToJsonSchemaConverter()
      jsonSchema = convert(validator)
    }

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
