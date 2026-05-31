import { canonicalJson, utf8, bytesToB64url, b64urlToBytes } from '@noy-db/attestation'

export const SHARE_LINK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h
export const SHARE_LINK_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7d cap

export interface MintShareLinkOptions {
  secret: Uint8Array
  baseUrl: string
  ttlMs?: number
  nowMs?: number
}

export interface ShareTokenParams {
  // Values come straight from a query string, which is inherently
  // `string | undefined`; accept undefined explicitly (exactOptionalPropertyTypes).
  d?: string | undefined
  exp?: string | undefined
  sig?: string | undefined
}

export type ShareVerdict =
  | { ok: true; docId: string }
  | { ok: false; reason: 'missing-token' | 'malformed' | 'expired' | 'invalid-signature' }

/** The exact bytes the HMAC covers — canonical, version-tagged, unambiguous. */
function signedMaterial(docId: string, exp: number): Uint8Array {
  return utf8(canonicalJson({ v: 1, docId, exp }))
}

async function hmacKey(secret: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

/** Firm-side: mint a shareable, self-expiring link for a docId. */
export async function mintShareLink(docId: string, opts: MintShareLinkOptions): Promise<string> {
  const now = opts.nowMs ?? Date.now()
  const ttl = Math.min(opts.ttlMs ?? SHARE_LINK_DEFAULT_TTL_MS, SHARE_LINK_MAX_TTL_MS)
  const exp = now + ttl
  const key = await hmacKey(opts.secret, 'sign')
  const sigBytes = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, signedMaterial(docId, exp) as BufferSource),
  )
  const url = new URL(opts.baseUrl)
  url.searchParams.set('d', docId)
  url.searchParams.set('exp', String(exp))
  url.searchParams.set('sig', bytesToB64url(sigBytes))
  return url.toString()
}

/** Lambda-side: verify a share token. Constant-time via subtle.verify. */
export async function verifyShareToken(
  params: ShareTokenParams,
  secret: Uint8Array,
  nowMs: number,
): Promise<ShareVerdict> {
  const { d, exp, sig } = params
  if (!d || !exp || !sig) return { ok: false, reason: 'missing-token' }
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || !Number.isInteger(expNum)) return { ok: false, reason: 'malformed' }
  if (nowMs >= expNum) return { ok: false, reason: 'expired' }
  let sigBytes: Uint8Array
  try {
    sigBytes = b64urlToBytes(sig)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const key = await hmacKey(secret, 'verify')
  const valid = await globalThis.crypto.subtle.verify(
    'HMAC', key, sigBytes as BufferSource, signedMaterial(d, expNum) as BufferSource,
  )
  return valid ? { ok: true, docId: d } : { ok: false, reason: 'invalid-signature' }
}
