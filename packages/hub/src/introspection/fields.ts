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
  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  format?: string
  items?: JsonSchemaShape
}

function jsonSchemaType(node: JsonSchemaShape): string {
  if (Array.isArray(node.type)) {
    const non = node.type.filter((t) => t !== 'null')
    return non[0] ?? 'opaque'
  }
  if (node.enum && Array.isArray(node.enum)) return 'enum'
  if (typeof node.type === 'string') return node.type
  return 'opaque'
}

function constraintsFor(node: JsonSchemaShape): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (node.enum) out.values = node.enum
  if (node.minLength !== undefined) out.minLength = node.minLength
  if (node.maxLength !== undefined) out.maxLength = node.maxLength
  if (node.pattern !== undefined) out.pattern = node.pattern
  if (node.format !== undefined) out.format = node.format
  if (node.minimum !== undefined) out.minimum = node.minimum
  if (node.maximum !== undefined) out.maximum = node.maximum
  if (node.exclusiveMinimum !== undefined) out.gt = node.exclusiveMinimum
  if (node.exclusiveMaximum !== undefined) out.lt = node.exclusiveMaximum
  return Object.keys(out).length === 0 ? undefined : out
}

export function jsonSchemaToFields(
  jsonSchema: unknown,
  source: FieldSource,
  refs?: Record<string, { target: string; mode: string }>,
): Record<string, FieldDescriptor> {
  if (!jsonSchema || typeof jsonSchema !== 'object') return {}
  const root = jsonSchema as JsonSchemaShape
  if (!root.properties || typeof root.properties !== 'object') return {}

  const required = new Set(Array.isArray(root.required) ? root.required : [])
  const out: Record<string, FieldDescriptor> = {}

  for (const [name, node] of Object.entries(root.properties)) {
    const descriptor: FieldDescriptor = {
      type: jsonSchemaType(node),
      source,
      ...(required.has(name) ? {} : { optional: true }),
      ...(refs?.[name] ? { references: `${refs[name].target}.id` } : {}),
    }
    const constraints = constraintsFor(node)
    if (constraints) (descriptor as { constraints?: Record<string, unknown> }).constraints = constraints
    out[name] = descriptor
  }

  return out
}
