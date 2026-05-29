/**
 * Pure encoding + hashing primitives. Zero deps; WebCrypto only.
 *
 * `canonicalJson` and `sha256Hex` are intentionally byte-identical to
 * hub's `history/ledger/entry.ts` implementations. They are REPLICATED
 * here (not imported) because this package is upstream of hub — importing
 * from hub would invert the dependency. The conformance test pins the
 * shared contract via fixed vectors.
 */

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: refusing to encode non-finite number ${String(value)}`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') throw new Error('canonicalJson: BigInt is not JSON-serializable')
  if (typeof value === 'undefined' || typeof value === 'function') {
    throw new Error(`canonicalJson: refusing to encode ${typeof value} — include all fields explicitly`)
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) parts.push(JSON.stringify(key) + ':' + canonicalJson(obj[key]))
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalJson: unexpected value type: ${typeof value}`)
}

export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8(input) as BufferSource)
  return new Uint8Array(digest)
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input))
}
