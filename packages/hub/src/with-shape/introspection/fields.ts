/**
 * Map a JSON Schema (Draft 2020-12 produced by `zod-to-json-schema`) into
 * the {@link FieldDescriptor} map consumed by {@link VaultSchemaSnapshot}.
 *
 * Used by both the persisted-schema path (decrypted envelope body) and the
 * live-validator path (in-process derivation).
 *
 * @module
 */

import type { FieldDescriptor, FieldSource } from './types.js'

interface JsonSchemaShape {
  type?: string | string[]
  properties?: Record<string, JsonSchemaShape>
  required?: string[]
  enum?: unknown[]
  const?: unknown
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  format?: string
  items?: JsonSchemaShape
  oneOf?: JsonSchemaShape[]
  anyOf?: JsonSchemaShape[]
}

function jsonSchemaType(node: JsonSchemaShape): string {
  if (Array.isArray(node.type)) {
    const non = node.type.filter((t) => t !== 'null')
    return non[0] ?? 'opaque'
  }
  if (node.enum && Array.isArray(node.enum)) return 'enum'
  // JSON Schema `const` is used by zod-to-json-schema for z.literal(...)
  if (node.const !== undefined) return 'enum'
  if (typeof node.type === 'string') return node.type
  return 'opaque'
}

// #657 — zod v4's native `toJSONSchema()` injects a ±Number.MAX_SAFE_INTEGER
// bound on every `.int()` field (a JS-safe-integer representability fact,
// not authored validation intent — `type: 'integer'` already carries it).
// Empirically verified: `z.number().int()` → `{type:'integer', minimum:
// -9007199254740991, maximum:9007199254740991}`, and — critically — zod
// emits NO metadata distinguishing that derived bound from an authored one
// at the exact same value (`z.number().min(-9007199254740991)
// .max(9007199254740991)` on a plain, non-int number produces a
// byte-identical minimum/maximum). Without that distinguishing signal, a
// value-based filter gated on `type === 'integer'` is the pragmatic call:
// it never touches a non-int field's authored bound (whatever its value),
// and an authored `.int().min(Number.MAX_SAFE_INTEGER)` is pathological
// either way, so folding it into the same omission is an acceptable trade.
function isIntSentinel(node: JsonSchemaShape, value: number): boolean {
  return node.type === 'integer' && Math.abs(value) === Number.MAX_SAFE_INTEGER
}

function constraintsFor(node: JsonSchemaShape): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (node.enum) out.values = node.enum
  // JSON Schema `const` (used by zod-to-json-schema for z.literal) — treat like a single-value enum
  if (node.const !== undefined) out.values = [node.const]
  if (node.minLength !== undefined) out.minLength = node.minLength
  if (node.maxLength !== undefined) out.maxLength = node.maxLength
  if (node.pattern !== undefined) out.pattern = node.pattern
  if (node.format !== undefined) out.format = node.format
  if (node.minimum !== undefined && !isIntSentinel(node, node.minimum)) out.minimum = node.minimum
  if (node.maximum !== undefined && !isIntSentinel(node, node.maximum)) out.maximum = node.maximum
  if (node.exclusiveMinimum !== undefined) out.gt = node.exclusiveMinimum
  if (node.exclusiveMaximum !== undefined) out.lt = node.exclusiveMaximum
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Extract fields from a single JSON Schema object node (must have `properties`).
 * Used by both the plain-object path and the per-member extraction in the union path.
 */
function extractObjectFields(
  obj: JsonSchemaShape,
  source: FieldSource,
  refs?: Record<string, { target: string; mode: string }>,
): { fields: Record<string, FieldDescriptor>; required: Set<string> } {
  const required = new Set(Array.isArray(obj.required) ? obj.required : [])
  const fields: Record<string, FieldDescriptor> = {}
  if (!obj.properties || typeof obj.properties !== 'object') return { fields, required }

  for (const [name, node] of Object.entries(obj.properties)) {
    const descriptor: FieldDescriptor = {
      type: jsonSchemaType(node),
      source,
      ...(required.has(name) ? {} : { optional: true }),
      ...(refs?.[name] ? { references: `${refs[name].target}.id` } : {}),
    }
    const constraints = constraintsFor(node)
    if (constraints) (descriptor as { constraints?: Record<string, unknown> }).constraints = constraints
    fields[name] = descriptor
  }

  return { fields, required }
}

/**
 * Merge field descriptors from multiple union members.
 *
 * Merge rules:
 * - Emit the UNION of all field names so no member's fields are hidden.
 * - A field is required (optional=false/absent) only when it is required in
 *   EVERY member; otherwise it is marked optional=true.
 * - For the discriminator field (appears in every member with a `const` value),
 *   collect the const values from all members and surface them as constraints.values
 *   so the caller can see the full literal set.
 * - For conflicting types across members, first-seen wins.
 */
function mergeUnionMembers(
  members: JsonSchemaShape[],
  source: FieldSource,
  refs?: Record<string, { target: string; mode: string }>,
): Record<string, FieldDescriptor> {
  if (members.length === 0) return {}

  // Extract per-member fields + required sets
  const extracted = members
    .filter((m) => m.properties && typeof m.properties === 'object')
    .map((m) => extractObjectFields(m, source, refs))

  if (extracted.length === 0) return {}

  // Collect all field names across all members
  const allNames = new Set<string>()
  for (const { fields } of extracted) {
    for (const name of Object.keys(fields)) allNames.add(name)
  }

  const memberCount = extracted.length
  const out: Record<string, FieldDescriptor> = {}

  for (const name of allNames) {
    // Which members contain this field?
    const presentIn = extracted.filter(({ fields }) => name in fields)
    const requiredInAll = presentIn.length === memberCount
      && presentIn.every(({ required }) => required.has(name))

    // Use first-seen descriptor as the base (presentIn is always non-empty here since
    // we iterate names that appeared in at least one member's fields)
    const base = presentIn[0]!.fields[name]!

    // For discriminator-like fields: collect const/enum values across all members
    // to surface the full literal set in constraints.values
    const allValues: unknown[] = []
    for (const { fields } of presentIn) {
      const fd = fields[name]
      if (fd?.constraints?.values && Array.isArray(fd.constraints.values)) {
        for (const v of fd.constraints.values) {
          if (!allValues.includes(v)) allValues.push(v)
        }
      }
    }

    const mergedConstraints: Record<string, unknown> | undefined =
      allValues.length > 0
        ? { ...(base.constraints ?? {}), values: allValues }
        : base.constraints

    const descriptor: FieldDescriptor = {
      type: base.type,
      source,
      ...(requiredInAll ? {} : { optional: true }),
      ...(base.references ? { references: base.references } : {}),
    }
    if (mergedConstraints) {
      (descriptor as { constraints?: Record<string, unknown> }).constraints = mergedConstraints
    }
    out[name] = descriptor
  }

  return out
}

export function jsonSchemaToFields(
  jsonSchema: unknown,
  source: FieldSource,
  refs?: Record<string, { target: string; mode: string }>,
): Record<string, FieldDescriptor> {
  if (!jsonSchema || typeof jsonSchema !== 'object') return {}
  const root = jsonSchema as JsonSchemaShape

  // Handle discriminated unions: zod-to-json-schema emits anyOf/oneOf for z.discriminatedUnion
  const unionMembers = root.anyOf ?? root.oneOf
  if (Array.isArray(unionMembers) && unionMembers.length > 0) {
    return mergeUnionMembers(unionMembers, source, refs)
  }

  if (!root.properties || typeof root.properties !== 'object') return {}

  const { fields } = extractObjectFields(root, source, refs)
  return fields
}
