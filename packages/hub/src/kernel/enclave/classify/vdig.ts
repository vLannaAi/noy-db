/**
 * The `_vdig` slot payload + crypto (stage 2, spec §2).
 *
 * A `_vdig[field]` blob is AES-256-GCM `"iv:data"` sealed under an
 * HKDF(CEK) slot key with AAD = ['noydb-classify-vdig', collection,
 * recordId, field] (C1 rollback-splice hardening). The AAD is NOT stored —
 * readers reconstruct it. It is deliberately `_v`-independent: C6's
 * carry-forward copies blob bytes verbatim across version bumps; the
 * same-record same-field TEMPORAL rollback residual is detected by the
 * ledger's conditional `_vdig` binding (envelope-body.ts).
 *
 * CEK-ONLY (I3): there is no DEK derivation and no
 * 'noydb-classify-vdig-dek' salt domain — every vdig slot dies with the
 * record's `_cek` (forget() shreds it totally; no vdig-dekResidue class).
 * @module
 */
import { encryptBytesWithAAD, decryptBytesWithAAD, base64ToBuffer, type EnclaveKey } from '../crypto.js'
import { TamperedError } from '../../errors.js'

const subtle = globalThis.crypto.subtle

export const VDIG_SALT_DOMAIN = 'noydb-classify-vdig'

export interface VdigDigestEntry {
  readonly salt: string   // base64 32-byte per-write random salt
  readonly hash: string   // base64 32-byte pbkdf2VerifyDigest output
}

export interface VdigPayload {
  readonly v: 1
  readonly alg: 'PBKDF2-SHA256'
  readonly iter: number
  readonly cur: VdigDigestEntry & { readonly at: string }  // ISO write-time
  /** Previous digests, oldest-first, length ≤ notLastN (cap 8). */
  readonly ring?: readonly VdigDigestEntry[]
}

/** Injective JSON-array AAD — same collision argument as deriveSealedFieldKey. */
export function buildVdigAad(collection: string, recordId: string, field: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([VDIG_SALT_DOMAIN, collection, recordId, field]))
}

/** HKDF(CEK) → non-extractable AES-256-GCM vdig slot key. CEK-only (I3). */
export async function deriveVdigSlotKey(
  cek: EnclaveKey,
  collection: string,
  field: string,
): Promise<EnclaveKey> {
  const raw = await subtle.exportKey('raw', cek)
  const hkdf = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(VDIG_SALT_DOMAIN)
  const info = new TextEncoder().encode(JSON.stringify([VDIG_SALT_DOMAIN, collection, field]))
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdf, 256)
  return subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function sealVdigPayload(
  payload: VdigPayload,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<string> {
  const key = await deriveVdigSlotKey(cek, collection, field)
  const { iv, data } = await encryptBytesWithAAD(
    new TextEncoder().encode(JSON.stringify(payload)),
    key,
    buildVdigAad(collection, recordId, field),
  )
  return `${iv}:${data}`
}

/** Throws TamperedError on any AAD / auth-tag mismatch (C1). */
export async function openVdigPayload(
  blob: string,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<VdigPayload> {
  const sep = blob.indexOf(':')
  if (sep === -1) throw new TamperedError()
  const ivPart = blob.slice(0, sep)
  const dataPart = blob.slice(sep + 1)
  try {
    base64ToBuffer(ivPart)
    base64ToBuffer(dataPart)
  } catch {
    throw new TamperedError()
  }
  const key = await deriveVdigSlotKey(cek, collection, field)
  const bytes = await decryptBytesWithAAD(
    ivPart,
    dataPart,
    key,
    buildVdigAad(collection, recordId, field),
  )
  return JSON.parse(new TextDecoder().decode(bytes)) as VdigPayload
}
