import type { AttestationFieldSchema } from './types.js'
import { canonicalJson, sha256Bytes, bytesToB64url } from './encoding.js'
import { getPath, normalizeField } from './normalize.js'

/**
 * One salted, domain-separated hash per declared field, in schema order:
 *   fieldHash[i] = base64url( sha256( canonicalJson([salt, path, normalizedValue]) ) )
 * Per-document salt defeats brute-force of low-entropy fields and cross-
 * document correlation; the path in the input domain-separates fields
 * that happen to share a value.
 */
export async function computeFieldHashes(
  saltB64: string,
  schema: AttestationFieldSchema,
  values: Record<string, unknown>,
): Promise<string[]> {
  const out: string[] = []
  for (const f of schema.fields) {
    const raw = getPath(values, f.path)
    if (raw === undefined || raw === null) {
      throw new Error(`computeFieldHashes: missing value at declared path '${f.path}'`)
    }
    const norm = normalizeField(raw, f.normalize)
    const digest = await sha256Bytes(canonicalJson([saltB64, f.path, norm]))
    out.push(bytesToB64url(digest))
  }
  return out
}
