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
 * this field" via-feature, and `makeSealedSlotCapability`/
 * `makeReservedEnvelopes` (below) are the `ViaCryptoCtx` capability
 * factories built on top of them.
 *
 * The capability factories live here (rather than a sibling
 * `kernel/via-crypto.ts`) so they can call `deriveSealedFieldKey`/
 * `deriveSealedFieldKeyFromCek`/`encrypt`/`decrypt` directly — this file IS
 * kernel enclave code (C3), so it is exempt from `enclave-barrel-only` the
 * same way `record-codec.ts`/`sealing.ts` are. A file outside
 * `kernel/enclave/**` would have had to go through the enclave barrel
 * (`kernel/enclave/index.ts`), which does not (yet) export these symbols.
 */
import { encrypt, decrypt, deriveSealedFieldKey, deriveSealedFieldKeyFromCek, type EnclaveKey } from '../crypto.js'
import { dualReadSealedSlot } from './sealed-slot.js'
import { buildRecordEnvelope } from '../record-envelope.js'
import { SealedHandle, type EncryptedEnvelope } from '../../types.js'
import { ValidationError } from '../../errors.js'
import type { SealedSlotRef, ViaCryptoCtx } from '../../via/index.js'

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
): Promise<SealedSlotRef> {
  const fieldKey = keyMaterial.cek !== undefined
    ? await deriveSealedFieldKeyFromCek(keyMaterial.cek, keyMaterial.collection, field)
    : await deriveSealedFieldKey(dek, keyMaterial.collection, field)
  return encrypt(JSON.stringify(value), fieldKey)
}

/**
 * Seal one field's value on demand — fetches the DEK itself. A singular
 * counterpart to {@link sealFields} for callers that seal one field at a
 * time rather than a whole record. Not exported — `makeSealedSlotCapability`
 * is the only caller (#629 Task 11: knip-flagged unused export, dropped;
 * intra-module use only).
 */
async function sealOneField(
  field: string,
  value: unknown,
  keyMaterial: SealKeyMaterial,
): Promise<SealedSlotRef> {
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

// ─────────────────────────────────────────────────────────────────────────
// ViaCryptoCtx capability factories (#629 Task 1, second commit)
// ─────────────────────────────────────────────────────────────────────────

/** What {@link makeSealedSlotCapability} needs — a subset of `RecordCodecContext`. */
export interface SealedSlotCapabilityCtx {
  readonly name: string
  getDEK(): Promise<EnclaveKey>
}

/**
 * Build a `ViaCryptoCtx.sealedSlots` capability pre-bound to one
 * `(collection, recordId)`. The key material (`cek`/DEK resolver) is closed
 * over and never placed on the returned object — `Object.keys`/
 * `Object.values` of the capability expose only the three methods, never a
 * key (zero-knowledge: capabilities never expose keys).
 *
 * `delete(field)` is **advisory and capability-instance-local, not real
 * erasure** — it has no store to reach and never will by itself: it just
 * adds `field` to a `Set` closed over by THIS ONE capability object, so a
 * later `unseal` call on that SAME object refuses. No I/O happens. A fresh
 * capability for the same record (e.g. `seal()`'d again, or a new
 * `makeSealedSlotCapability(...)` call) has an empty set and sees no
 * deletion at all — `seal()` on a given field also clears any prior mark
 * for it. Do not build production logic on `delete()` persisting anything.
 * The real erasure guarantee for a forgotten record is `vault.forget()`'s
 * unconditional `_writeTombstone` call, which replaces the whole live
 * envelope with a fresh, `_sealed`-free tombstone — `_sealed` disappears
 * from the store regardless of what any capability's `delete()` marked.
 * (#629 Task 10 traced this end-to-end; see task-10-report.md "sealedSlots
 * .delete()" section. Removing/changing this method's shape is a phase-E
 * decision, not implied by this comment.)
 */
export function makeSealedSlotCapability(
  ctx: SealedSlotCapabilityCtx,
  recordId: string,
  cek?: EnclaveKey,
): ViaCryptoCtx['sealedSlots'] {
  const keyMaterial: SealKeyMaterial = {
    collection: ctx.name,
    ...(cek !== undefined ? { cek } : {}),
    getDEK: () => ctx.getDEK(),
  }
  const deletedFields = new Set<string>()

  return {
    async seal(field, plaintext) {
      const ref = await sealOneField(field, plaintext, keyMaterial)
      deletedFields.delete(field)
      return ref
    },
    async unseal(field, ref) {
      if (deletedFields.has(field)) {
        throw new ValidationError(`sealedSlots.unseal: field "${field}" on record "${recordId}" was deleted from this capability`)
      }
      return unsealOneField(field, `${ref.iv}:${ref.data}`, keyMaterial)
    },
    async delete(field) {
      deletedFields.add(field)
    },
  }
}

/** Resolve the DEK for an arbitrary (possibly synthetic, e.g. `_dict_en`) collection name. */
export type ReservedEnvelopeDekResolver = (collection: string) => Promise<EnclaveKey>

/**
 * Build a `ViaCryptoCtx.reservedEnvelopes` capability: a whole-envelope
 * encrypt/decrypt door scoped to collection names under a declared prefix
 * (e.g. `_dict_`) — the shape `via/i18n/dictionary.ts`'s
 * `DictionaryHandle` needs (seam map Part 3): build JSON → encrypt under a
 * DEK → wrap in an `EncryptedEnvelope`; decrypt → JSON text. No per-record
 * CEK — reserved envelopes are whole-DEK-encrypted, same as the dictionary
 * grandfather.
 *
 * `reservedEnvelopes(prefix)` throws `ValidationError` immediately when
 * `prefix` is not in `declaredPrefixes`; each `encrypt`/`decrypt` call
 * throws `ValidationError` when its `collection` argument does not start
 * with `prefix`.
 */
export function makeReservedEnvelopes(
  dekResolver: ReservedEnvelopeDekResolver,
  declaredPrefixes: readonly string[],
): ViaCryptoCtx['reservedEnvelopes'] {
  const declared = new Set(declaredPrefixes)

  return (prefix: string) => {
    if (!declared.has(prefix)) {
      throw new ValidationError(`reservedEnvelopes: prefix "${prefix}" is not declared by this binding's reservedPrefixes`)
    }

    const assertPrefixed = (collection: string, method: 'encrypt' | 'decrypt'): void => {
      if (!collection.startsWith(prefix)) {
        throw new ValidationError(
          `reservedEnvelopes('${prefix}').${method}: collection "${collection}" does not start with "${prefix}"`,
        )
      }
    }

    const encryptForPrefix = async (collection: string, id: string, json: string, v: number): Promise<EncryptedEnvelope> => {
      assertPrefixed(collection, 'encrypt')
      const dek = await dekResolver(collection)
      const { iv, data } = await encrypt(json, dek)
      return buildRecordEnvelope({ collection, id }, { version: v, iv, data })
    }

    const decryptForPrefix = async (collection: string, env: EncryptedEnvelope): Promise<string> => {
      assertPrefixed(collection, 'decrypt')
      const dek = await dekResolver(collection)
      return decrypt(env._iv, env._data, dek)
    }

    return { encrypt: encryptForPrefix, decrypt: decryptForPrefix }
  }
}
