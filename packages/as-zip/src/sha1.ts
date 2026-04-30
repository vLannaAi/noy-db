/**
 * Thin Web-Crypto wrappers for SHA-1 / HMAC-SHA1.
 *
 * SHA-1 is unsafe for new collision-resistance applications, but
 * WinZip-AES specifies it as both the PBKDF2 hash and the HMAC
 * primitive — switching primitives would break interop with every
 * archive tool that consumes the format. This module exists so the
 * WinZip-AES code path doesn't grow `crypto.subtle` boilerplate at
 * every call site, and so any future primitive swap touches one
 * file.
 *
 * @module
 */

export async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return new Uint8Array(digest)
}

export async function hmacSha1(key: Uint8Array, bytes: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, bytes as BufferSource)
  return new Uint8Array(sig)
}
