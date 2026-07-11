/**
 * Sealed-slot sub-step — the "seal these declared fields into their own
 * `iv:data` slots" mechanism, extracted byte-parity from `RecordCodec`
 * (#629 Task 1; see `.superpowers/sdd/seam-map-classified-blobs.md` §2).
 *
 * This is the ONE genuinely separable sub-step `RecordCodec.encryptRecord`/
 * `decryptRecord` perform (the digest-only `_vdig`/`_bidx` mechanism is NOT
 * separable the same way — it needs write-history `prev` context, see the
 * seam map's separability verdict). `sealFields`/`unsealFields` are the
 * natural shape of a `via` `encodeAtRest`/`decodeAtRest` hook for a "seal
 * this field" via-feature.
 */
import { encrypt, deriveSealedFieldKey, deriveSealedFieldKeyFromCek, type EnclaveKey } from '../crypto.js'
import { dualReadSealedSlot } from './sealed-slot.js'
import { SealedHandle } from '../../types.js'

/**
 * Key material for one collection's sealed-field derivation. `cek`, when
 * supplied, is preferred (record-scoped); `getDEK` is the fallback (and,
 * for legacy/no-CEK collections, the only key) — mirrors the dual-read
 * `RecordCodec` has always done.
 */
export interface SealKeyMaterial {
  readonly collection: string
  readonly cek?: EnclaveKey
  getDEK(): Promise<EnclaveKey>
}

export interface SealFieldsResult {
  readonly openRecord: Record<string, unknown>
  readonly sealed: Record<string, string> | undefined
}

/** Seal one field's value to an `iv:data` slot under its derived per-field key. */
async function sealOneFieldWithDek(
  field: string,
  value: unknown,
  dek: EnclaveKey,
  keyMaterial: SealKeyMaterial,
): Promise<{ iv: string; data: string }> {
  const fieldKey = keyMaterial.cek !== undefined
    ? await deriveSealedFieldKeyFromCek(keyMaterial.cek, keyMaterial.collection, field)
    : await deriveSealedFieldKey(dek, keyMaterial.collection, field)
  return encrypt(JSON.stringify(value), fieldKey)
}

/**
 * Seal one field's value on demand — fetches the DEK itself. A singular
 * counterpart to {@link sealFields} for callers that seal one field at a
 * time rather than a whole record.
 */
export async function sealOneField(
  field: string,
  value: unknown,
  keyMaterial: SealKeyMaterial,
): Promise<{ iv: string; data: string }> {
  const dek = await keyMaterial.getDEK()
  return sealOneFieldWithDek(field, value, dek, keyMaterial)
}

/**
 * Peel declared `sensitiveFields` out of `record` BEFORE building `_data`,
 * sealing each into its own `iv:data` slot. Extracted byte-parity from
 * `RecordCodec.encryptRecord` step 2 (pre-#629 `record-codec.ts:261-288`).
 * Returns `record` untouched (and `sealed: undefined`) when no declared
 * field is present with a defined value — the envelope stays byte-identical
 * to legacy output, exactly as before.
 */
export async function sealFields(
  record: Record<string, unknown>,
  sensitiveFields: ReadonlySet<string>,
  keyMaterial: SealKeyMaterial,
): Promise<SealFieldsResult> {
  const dek = await keyMaterial.getDEK()
  const open: Record<string, unknown> = { ...record }
  const slots: Record<string, string> = {}
  for (const field of sensitiveFields) {
    if (!(field in record)) continue
    const value = record[field]
    if (value === undefined) continue
    const { iv, data } = await sealOneFieldWithDek(field, value, dek, keyMaterial)
    slots[field] = `${iv}:${data}`
    delete open[field]
  }
  if (Object.keys(slots).length === 0) return { openRecord: record, sealed: undefined }
  return { openRecord: open, sealed: slots }
}

/**
 * Unseal one `_sealed[field]` slot to its plaintext value: dual-read (try
 * the CEK-derived key, fall back to the DEK-derived key for legacy
 * records), AES-GCM-decrypt the `iv:data` blob, and JSON-parse the result.
 * Extracted byte-parity from `RecordCodec.unsealField`
 * (pre-#629 `record-codec.ts:485-493`).
 */
export async function unsealOneField(field: string, blob: string, keyMaterial: SealKeyMaterial): Promise<unknown> {
  const dek = await keyMaterial.getDEK()
  return JSON.parse(await dualReadSealedSlot(blob, field, keyMaterial.collection, keyMaterial.cek, dek))
}

/**
 * Build a non-leaking {@link SealedHandle} producer over sealed key
 * material: each call captures only the ciphertext `blob` and a closure to
 * {@link unsealOneField} — the plaintext is never stored on the handle, and
 * (crucially) the DEK is fetched lazily on `reveal()`, never at handle-
 * construction time. Extracted byte-parity from
 * `RecordCodec.makeSealedHandle` (pre-#629 `record-codec.ts:552-554`).
 */
export function makeHandleProducer(keyMaterial: SealKeyMaterial): (field: string, blob: string) => SealedHandle<unknown> {
  return (field, blob) => new SealedHandle(() => unsealOneField(field, blob, keyMaterial))
}

/**
 * Restore every `[field]: blob` entry in `sealed` onto `record` (mutated in
 * place, matching the original's mutate-then-return shape): eagerly unseal
 * to plaintext (`opts.asHandles` falsy) or wrap each in a
 * {@link SealedHandle} (`opts.asHandles: true`) so the plaintext is never
 * materialised. Extracted byte-parity from `RecordCodec.decryptRecord`'s
 * sealed-handle block (pre-#629 `record-codec.ts:615-623`).
 */
export async function unsealFields(
  record: Record<string, unknown>,
  sealed: Record<string, string>,
  keyMaterial: SealKeyMaterial,
  opts?: { asHandles?: boolean },
): Promise<Record<string, unknown>> {
  const makeHandle = opts?.asHandles === true ? makeHandleProducer(keyMaterial) : undefined
  for (const [field, blob] of Object.entries(sealed)) {
    record[field] = makeHandle !== undefined ? makeHandle(field, blob) : await unsealOneField(field, blob, keyMaterial)
  }
  return record
}
