/**
 * Standard Schema v1 integration.
 *
 * This file is the v0.4 entry point for **schema validation**. Any
 * validator that implements the [Standard Schema v1
 * protocol](https://standardschema.dev) — Zod, Valibot, ArkType, Effect
 * Schema, etc. — can be attached to a `Collection` or `defineNoydbStore`
 * and will:
 *
 *   1. Validate the record BEFORE encryption on `put()` — bad data is
 *      rejected at the store boundary with a rich issue list.
 *   2. Validate the record AFTER decryption on `get()`/`list()`/`query()`
 *      — stored data that has drifted from the current schema throws
 *      loudly instead of silently propagating garbage to the UI.
 *
 * ## Why vendor the types?
 *
 * Standard Schema is a protocol, not a library. The spec is <200 lines of
 * TypeScript and has no runtime. There's an official `@standard-schema/spec`
 * types package on npm, but pulling it in would add a dependency edge
 * purely for type definitions. Vendoring the minimal surface keeps
 * `@noy-db/core` at **zero runtime dependencies** and gives us freedom to
 * evolve the helpers without a version-lock on the spec package.
 *
 * If the spec changes in a breaking way (unlikely — it's frozen at v1),
 * we update this file and bump our minor.
 *
 * ## Why not just run `schema.parse(value)` directly?
 *
 * Because then we'd be locked to whichever validator happens to have
 * `.parse`. Standard Schema's `'~standard'.validate` contract is the same
 * across every implementation and includes a structured issues list,
 * which is much more useful than a thrown error for programmatic error
 * handling (e.g., rendering field-level messages in a Vue component).
 */

import { SchemaValidationError } from './errors.js'

/**
 * The Standard Schema v1 protocol. A schema is any object that exposes a
 * `'~standard'` property with `version: 1` and a `validate` function.
 *
 * The type parameters are:
 *   - `Input`  — the type accepted by `validate` (what the user passes in)
 *   - `Output` — the type produced by `validate` (what we store/return,
 *                may differ from Input if the schema transforms or coerces)
 *
 * In most cases `Input === Output`, but validators that transform
 * (Zod's `.transform`, Valibot's `transform`, etc.) can narrow or widen.
 *
 * We intentionally keep the `types` field `readonly` and optional — the
 * spec marks it as optional because it's only used for inference, and
 * not every implementation bothers populating it at runtime.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1SyncResult<Output>
      | Promise<StandardSchemaV1SyncResult<Output>>
    readonly types?:
      | {
          readonly input: Input
          readonly output: Output
        }
      | undefined
  }
}

/**
 * The result of a single call to `schema['~standard'].validate`. Either
 * `{ value }` on success or `{ issues }` on failure — never both.
 *
 * The spec allows `issues` to be undefined on success (and some
 * validators leave it that way), so consumers should discriminate on
 * `issues?.length` rather than on truthiness of `value`.
 */
export type StandardSchemaV1SyncResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly value?: undefined
      readonly issues: readonly StandardSchemaV1Issue[]
    }

/**
 * A single validation issue. The `message` is always present; the `path`
 * is optional and points at the offending field when the schema tracks
 * it (virtually every validator does for object types).
 *
 * The path is deliberately permissive — both a plain `PropertyKey` and a
 * `{ key }` wrapper are allowed so validators that wrap path segments in
 * objects (Zod does this in some modes) don't need special handling.
 */
export interface StandardSchemaV1Issue {
  readonly message: string
  readonly path?:
    | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
    | undefined
}

/**
 * Infer the output type of a Standard Schema. Consumers use this to
 * pull the type out of a schema instance when they want to declare a
 * Collection<T> or defineNoydbStore<T> with `T` derived from the schema.
 *
 * Example:
 * ```ts
 * const InvoiceSchema = z.object({ id: z.string(), amount: z.number() })
 * type Invoice = InferOutput<typeof InvoiceSchema>
 * ```
 */
export type InferOutput<T extends StandardSchemaV1> =
  T extends StandardSchemaV1<unknown, infer O> ? O : never

/**
 * Validate an input value against a schema. Throws
 * `SchemaValidationError` if the schema rejects, with the rich issue
 * list attached. Otherwise returns the (possibly transformed) output
 * value.
 *
 * The `context` string is included in the thrown error's message so the
 * caller knows where the failure happened (e.g. `"put(inv-001)"`) without
 * every caller having to wrap the throw in a try/catch.
 *
 * This function is ALWAYS async because some validators (notably Effect
 * Schema and Zod's `.refine` with async predicates) can return a
 * Promise. We `await` the result unconditionally to normalize the
 * contract — the extra microtask is free compared to the cost of an
 * encrypt/decrypt round-trip.
 */
export async function validateSchemaInput<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
  context: string,
): Promise<Output> {
  const result = await schema['~standard'].validate(value)
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new SchemaValidationError(
      `Schema validation failed on ${context}: ${summarizeIssues(result.issues)}`,
      result.issues,
      'input',
    )
  }
  // Safe: the spec guarantees `value` is present when `issues` is absent.
  return result.value as Output
}

/**
 * Validate an already-stored value coming OUT of the collection. This
 * is a distinct helper from `validateSchemaInput` because the error
 * semantics differ: an output-validation failure means the data in
 * storage has drifted from the current schema (an unexpected state),
 * whereas an input-validation failure means the user passed bad data
 * (an expected state for a UI that isn't guarding its inputs).
 *
 * We still throw — silently returning bad data would be worse — but
 * the error carries `direction: 'output'` so upstream code (and a
 * potential migrate hook) can distinguish the two cases.
 */
export async function validateSchemaOutput<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
  context: string,
): Promise<Output> {
  const result = await schema['~standard'].validate(value)
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new SchemaValidationError(
      `Stored data for ${context} does not match the current schema — ` +
        `schema drift? ${summarizeIssues(result.issues)}`,
      result.issues,
      'output',
    )
  }
  return result.value as Output
}

/**
 * Produce a short human-readable summary of an issue list for the
 * thrown error's message. The full issue array is still attached to the
 * error as a property — this is only for the `.message` string that
 * shows up in console.error / stack traces.
 *
 * Format: `field: message; field2: message2` (up to 3 issues, then `…`).
 * Issues without a path are shown as `root: message`.
 */
function summarizeIssues(
  issues: readonly StandardSchemaV1Issue[],
): string {
  const shown = issues.slice(0, 3).map((issue) => {
    const pathStr = formatPath(issue.path)
    return `${pathStr}: ${issue.message}`
  })
  const suffix = issues.length > 3 ? ` (+${issues.length - 3} more)` : ''
  return shown.join('; ') + suffix
}

function formatPath(
  path: StandardSchemaV1Issue['path'],
): string {
  if (!path || path.length === 0) return 'root'
  return path
    .map((segment) =>
      typeof segment === 'object' && segment !== null
        ? String(segment.key)
        : String(segment),
    )
    .join('.')
}
