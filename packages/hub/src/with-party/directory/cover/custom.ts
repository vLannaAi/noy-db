/**
 * The cover's namespaced `custom` extension slot (#800) — input
 * validation, the namespace-level patch merge, and the post-merge
 * size caps.
 *
 * Like everything on the cover, `custom` is plaintext, public by
 * design, and unauthenticated — payloads are hints (display defaults,
 * routing suggestions, registry pointers), never an input to
 * security, authorization, or data-integrity decisions.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 *
 * @module
 */
import { ValidationError } from '../../../kernel/errors.js'
import type { Cover, JsonValue, ResolvedCoverSchema } from './types.js'

/**
 * Namespace keys must be reverse-DNS or package-style identifiers —
 * at least one dot/dash-separated segment (`noydb.viewer`,
 * `com.acme.registry` pass; a bare `config` fails), so two frameworks
 * can't collide on a bare word.
 */
const CUSTOM_KEY_PATTERN = /^[a-z0-9]+([.-][a-z0-9]+)+$/i

/** Maximum nesting depth of a namespace payload (containers, not leaves). */
const MAX_CUSTOM_DEPTH = 8

/**
 * Validate the owner-supplied `custom` input: the field must be a
 * plain object, every key must match {@link CUSTOM_KEY_PATTERN}, and
 * every value must be JSON-serializable (no functions, `undefined`,
 * symbols, bigints, or cycles) within the depth cap. `null` is
 * accepted — it is the delete-this-namespace directive and never
 * persists. Throws `ValidationError` on the first violation.
 */
export function validateCustomInput(custom: Record<string, JsonValue>): void {
  if (custom === null || typeof custom !== 'object' || Array.isArray(custom)) {
    throw new ValidationError(
      `setCover: custom must be a { [namespace]: value } object, got ${
        Array.isArray(custom) ? 'array' : typeof custom
      }.`,
    )
  }
  for (const [ns, value] of Object.entries(custom)) {
    if (!CUSTOM_KEY_PATTERN.test(ns)) {
      throw new ValidationError(
        `setCover: custom namespace "${ns}" is invalid. Keys must be ` +
          'reverse-DNS or package-style identifiers with at least one ' +
          'dot/dash-separated segment (e.g. "noydb.viewer", "com.acme.registry").',
      )
    }
    assertJsonValue(value, ns, 1, new Set())
  }
}

function assertJsonValue(
  value: unknown,
  ns: string,
  depth: number,
  seen: Set<object>,
): void {
  if (value === null) return
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return
  if (t !== 'object') {
    throw new ValidationError(
      `setCover: custom["${ns}"] contains a non-JSON value (${t}). ` +
        'Only strings, numbers, booleans, null, arrays, and plain objects are allowed.',
    )
  }
  const container = value as object
  if (seen.has(container)) {
    throw new ValidationError(
      `setCover: custom["${ns}"] contains a circular reference.`,
    )
  }
  if (depth > MAX_CUSTOM_DEPTH) {
    throw new ValidationError(
      `setCover: custom["${ns}"] nests deeper than the ${MAX_CUSTOM_DEPTH}-level cap.`,
    )
  }
  seen.add(container)
  const children = Array.isArray(container) ? container : Object.values(container)
  for (const child of children) {
    assertJsonValue(child, ns, depth + 1, seen)
  }
  seen.delete(container)
}

/**
 * Namespace-level patch merge for `setCover`: provided namespaces
 * replace their previous value, absent namespaces are preserved, and
 * an explicit `null` deletes that namespace (so `null` never persists
 * as a namespace value). A whole-`custom`-absent patch preserves the
 * previous custom, consistent with the other cover fields. Rationale:
 * framework A must never need read-modify-write of framework B's data.
 *
 * Returns a spreadable fragment — `{ custom }` when the merge leaves
 * at least one namespace, `{}` when it leaves none (the field is
 * dropped from the persisted document rather than stored empty).
 */
export function mergeCustom(
  existing: Record<string, JsonValue> | undefined,
  patch: Record<string, JsonValue> | undefined,
): { custom: Record<string, JsonValue> } | Record<string, never> {
  if (patch === undefined) {
    return existing !== undefined ? { custom: existing } : {}
  }
  const merged: Record<string, JsonValue> = { ...existing }
  for (const [ns, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[ns]
    } else {
      merged[ns] = value
    }
  }
  return Object.keys(merged).length > 0 ? { custom: merged } : {}
}

/**
 * Post-merge size caps — validates the WOULD-BE-PERSISTED document
 * (after the namespace merge), so a small patch can't tip the stored
 * cover over a cap unnoticed. `maxCoverBytes` bounds the entire
 * serialized document, which also closes the unbounded locale-map
 * key-count hole for `name` / `description`. Sizes are measured as
 * `JSON.stringify` length. Throws `ValidationError` on violation.
 */
export function validateCoverSize(
  cover: Cover,
  schema: ResolvedCoverSchema,
): void {
  if (cover.custom !== undefined) {
    const customSize = JSON.stringify(cover.custom).length
    if (customSize > schema.maxCustomBytes) {
      throw new ValidationError(
        `setCover: custom exceeds the ${schema.maxCustomBytes}-byte cap ` +
          `(got ${customSize} bytes serialized, after merging with the stored namespaces).`,
      )
    }
  }
  const totalSize = JSON.stringify(cover).length
  if (totalSize > schema.maxCoverBytes) {
    throw new ValidationError(
      `setCover: the cover document exceeds the ${schema.maxCoverBytes}-byte cap ` +
        `(got ${totalSize} bytes serialized).`,
    )
  }
}
