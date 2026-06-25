/**
 * `buildJsonSchema` — pure overlay that merges describe() metadata onto a
 * base JSON Schema (from derivePersistedSchema) as `x-` extension keys.
 *
 * When no base JSON Schema is available (non-zod / unknown validator),
 * builds a minimal `{ type:'object', properties }` from describe()'s field
 * type tags. No static `import 'zod'` — validator derivation stays lazy.
 *
 * @module
 */

import type { CollectionDescription, DescribedField } from './describe.js'

/** Map a DescribedField's type tag to a JSON-Schema `type`. */
function jsonType(t: string): string {
  switch (t) {
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'array'
    case 'object': return 'object'
    default: return 'string'
  }
}

/** Overlay describe() metadata onto a base JSON Schema (or build a minimal one). */
export function buildJsonSchema(desc: CollectionDescription, base?: Record<string, unknown> | null): object {
  const baseProps = (base?.['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {}
  const properties: Record<string, Record<string, unknown>> = {}
  for (const f of desc.fields) {
    const prop: Record<string, unknown> = { ...(baseProps[f.key] ?? { type: jsonType(f.type) }) }
    prop['x-label'] = f.label
    if (f.unit !== undefined) prop['x-unit'] = f.unit
    if (f.semanticType !== undefined) prop['x-semanticType'] = f.semanticType
    if (f.sensitivity !== undefined) prop['x-sensitivity'] = f.sensitivity
    if (f.widget !== undefined) prop['x-widget'] = f.widget
    if (f.editable === false) prop['x-readonly'] = true
    if (f.money !== undefined) prop['x-money'] = f.money
    if (f.ref !== undefined) prop['x-ref'] = f.ref.target
    if (f.dict?.values) {
      const labels: Record<string, string> = {}
      for (const v of f.dict.values) if (v.label !== undefined) labels[v.value] = v.label
      if (Object.keys(labels).length) prop['x-enumLabels'] = labels
    }
    properties[f.key] = prop
  }
  return base != null && typeof base === 'object'
    ? { ...base, properties }
    : { type: 'object', properties }
}

// Re-export the type for callers that want to document the parameter shape.
export type { CollectionDescription, DescribedField }
