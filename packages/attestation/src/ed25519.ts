import { bytesToB64url, b64urlToBytes, sha256Hex } from './encoding.js'

const ALG = 'Ed25519'

/** Cast a Uint8Array to the narrower ArrayBuffer WebCrypto expects. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Stable key identifier: first 16 hex chars of sha256(publicKeyB64). */
export async function keyIdFor(publicKeyB64: string): Promise<string> {
  return (await sha256Hex(publicKeyB64)).slice(0, 16)
}

export async function generateDocSigningKeyPair(): Promise<{
  keyId: string
  publicKeyB64: string        // base64url raw (32 bytes) — non-secret, publishable
  privateKeyPkcs8B64: string  // base64url pkcs8 — secret, wrap before persisting
}> {
  const kp = (await globalThis.crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey))
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const publicKeyB64 = bytesToB64url(rawPub)
  return { keyId: await keyIdFor(publicKeyB64), publicKeyB64, privateKeyPkcs8B64: bytesToB64url(pkcs8) }
}

export async function ed25519Sign(privateKeyPkcs8B64: string, message: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(b64urlToBytes(privateKeyPkcs8B64)),
    ALG,
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign(ALG, key, toArrayBuffer(message)))
  return bytesToB64url(sig)
}

export async function ed25519Verify(publicKeyB64: string, sigB64url: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      toArrayBuffer(b64urlToBytes(publicKeyB64)),
      ALG,
      false,
      ['verify'],
    )
    return await globalThis.crypto.subtle.verify(
      ALG,
      key,
      toArrayBuffer(b64urlToBytes(sigB64url)),
      toArrayBuffer(message),
    )
  } catch {
    return false
  }
}
