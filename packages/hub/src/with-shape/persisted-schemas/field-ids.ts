/**
 * Stable field-identifier minting (#946).
 *
 * A field's `id` is opaque and permanent — minted once, from randomness
 * only, with no timestamp and no name-derivation. A name-derived id would
 * change when the field is renamed, defeating the whole point (identity
 * must survive a rename). See `PersistedSchemaEnvelope.fieldIds`.
 *
 * @module
 */

const BASE32URL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Unpadded RFC 4648 §7 base32url encoding of an arbitrary byte string. */
function encodeBase32Url(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32URL_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32URL_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

/**
 * Mint a fresh opaque field id: 12 random bytes (96 bits) from
 * `crypto.getRandomValues`, encoded as a 20-character base32url token.
 * Not exported — Task 2/3 (#946) may need to export this later; keep it
 * module-internal until an external consumer exists.
 */
function mintFieldId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return encodeBase32Url(bytes)
}

/** Top-level property names of a Draft 2020-12 object JSON Schema, or `[]` when not an object schema. */
function topLevelFieldNames(jsonSchema: object | null): readonly string[] {
  if (jsonSchema === null) return []
  const props = (jsonSchema as { properties?: unknown }).properties
  if (props === null || typeof props !== 'object') return []
  return Object.keys(props as Record<string, unknown>)
}

/**
 * Resolve the `fieldIds` map for a freshly-derived schema against the
 * previously-stored envelope's map (if any). Existing ids are preserved by
 * name — a field keeps its id across re-derivation as long as its name is
 * unchanged; a genuinely new field name mints a fresh id. Returns
 * `undefined` when the fresh schema has no derivable top-level field set
 * (e.g. a stub envelope, or a non-object root schema).
 *
 * `renamed` (#946 Task 2) — unambiguous rename pairs from
 * `computeSchemaDelta`'s `SchemaDelta.renamed`. When the fresh name is a
 * rename target (`to`), the id is looked up under its OLD name (`from`)
 * instead of the fresh name itself — the whole point of a stable field id
 * is that it survives exactly this case; without it, a rename would mint a
 * fresh id for the new name and silently drop the old one.
 */
export function resolveFieldIds(
  freshJsonSchema: object | null,
  priorFieldIds: Record<string, string> | undefined,
  renamed?: readonly { readonly from: string; readonly to: string }[],
): Record<string, string> | undefined {
  const names = topLevelFieldNames(freshJsonSchema)
  if (names.length === 0) return undefined
  const priorNameFor = new Map<string, string>()
  if (renamed) for (const { from, to } of renamed) priorNameFor.set(to, from)
  const out: Record<string, string> = {}
  for (const name of names) {
    const priorName = priorNameFor.get(name) ?? name
    out[name] = priorFieldIds?.[priorName] ?? mintFieldId()
  }
  return out
}
