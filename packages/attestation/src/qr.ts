import { bytesToB64url, b64urlToBytes, utf8 } from './encoding.js'

export interface QrPayload {
  readonly v: 1
  readonly docId: string
  readonly salt: string
  readonly alg: 'ed25519'
  readonly keyId: string
  readonly fieldHashes: readonly string[]
  readonly sig: string
}

/** Compact JSON → base64url. (CBOR + base45 density optimisation deferred.) */
export function encodeQr(p: QrPayload): string {
  return bytesToB64url(utf8(JSON.stringify(p)))
}

export function decodeQr(s: string): QrPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
  } catch {
    throw new Error('decodeQr: invalid base64url-encoded JSON payload')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('decodeQr: invalid payload — expected a JSON object')
  }
  const p = parsed as Record<string, unknown>
  if (p['v'] !== 1) throw new Error(`decodeQr: unsupported version ${String(p['v'])} (expected 1)`)
  if (typeof p['docId'] !== 'string' || typeof p['salt'] !== 'string' || p['alg'] !== 'ed25519'
      || typeof p['keyId'] !== 'string' || typeof p['sig'] !== 'string'
      || !Array.isArray(p['fieldHashes']) || !p['fieldHashes'].every((h) => typeof h === 'string')) {
    throw new Error('decodeQr: invalid payload shape')
  }
  return {
    v: 1, docId: p['docId'], salt: p['salt'], alg: 'ed25519',
    keyId: p['keyId'], fieldHashes: p['fieldHashes'] as string[], sig: p['sig'],
  }
}
