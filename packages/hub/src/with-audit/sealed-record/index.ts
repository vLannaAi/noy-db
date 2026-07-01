/**
 * `@noy-db/hub/sealed-record` — host-side opener for record-scoped CEK
 * sealing (#306 slices 2-3).
 *
 * The **grantor** side (sealing a record's CEK to a host, revoking, and hard
 * rotation) lives on `Vault` (`vault.sealRecordToHost` /
 * `vault.revokeSealedRecord` / `vault.rotateRecordCek`) because it needs the
 * collection DEK. This subpath exposes the **recipient host** side:
 * {@link openSealedRecord} reconstructs a single record's plaintext from
 * (a) the sealed-CEK delivery envelope, (b) the record's encrypted envelope
 * body, and (c) the host's own unsealer — and **nothing else**. The host never
 * touches a vault DEK and can decrypt exactly the one bound record.
 *
 * @module
 */

import { decrypt, base64ToBuffer } from '../../kernel/enclave/crypto.js'
import {
  SealedRecordExpiredError,
  SealedRecordMismatchError,
} from '../../errors.js'
import type {
  SealedCekDeliveryEnvelope,
  SealedCekBinding,
} from './types.js'

export type { SealedCekDeliveryEnvelope, SealedCekBinding } from './types.js'
export { SealedRecordExpiredError, SealedRecordMismatchError } from '../../errors.js'

const subtle = globalThis.crypto.subtle

/**
 * Host-side: decrypt a single record whose CEK was sealed to this host by a
 * vault grantor via `vault.sealRecordToHost()`.
 *
 * Verification order (security-critical — do NOT reorder past the unseal):
 *  1. **Fast-path expiry** — reject on the delivery envelope's clear-text
 *     `expiresAt` before doing any (potentially expensive) unseal work. This is
 *     a hint only.
 *  2. **Unseal** the `payload` with the host's `recipientSealer.unseal` →
 *     parse the {@link SealedCekBinding}.
 *  3. **Binding match** — the binding's `{collection, id}` MUST equal the
 *     expected pair, else {@link SealedRecordMismatchError}. This is the
 *     host-denial boundary (a CEK sealed for record A cannot open record B).
 *  4. **Authoritative expiry** — re-check `binding.expiresAt` (the copy that
 *     cannot be forged by editing the delivery envelope), else
 *     {@link SealedRecordExpiredError}.
 *  5. **Decrypt** the record body under the unsealed CEK. A CEK from a
 *     PRE-rotation seal applied to a POST-rotation live envelope passes (1)-(4)
 *     but fails the AES-GCM auth tag → `TamperedError` from `decrypt`.
 *
 * @param sealedCekEnvelope The `SealedCekDeliveryEnvelope` written by the grantor.
 * @param recordEnvelope    The record's `{ _iv, _data }` (the encrypted body).
 * @param recipientSealer   The host's unsealer (`{ unseal(bytes) }`) — e.g. a
 *                          KMS-backed sealer or `MemoryRecipientSealer`.
 * @param expectedCollection Collection the caller believes `recordEnvelope` is in.
 * @param expectedId         Record id the caller believes `recordEnvelope` is.
 * @returns The decrypted record body as a JSON string.
 */
export async function openSealedRecord(
  sealedCekEnvelope: SealedCekDeliveryEnvelope,
  recordEnvelope: { readonly _iv: string; readonly _data: string },
  recipientSealer: { unseal(bytes: Uint8Array): Promise<Uint8Array> },
  expectedCollection: string,
  expectedId: string,
): Promise<string> {
  // (1) Fast-path expiry on the (unauthenticated) delivery envelope. Fail
  // CLOSED (M-4): a malformed/empty `expiresAt` parses to NaN — treat it as
  // expired rather than letting `NaN <= now` (which is `false`) skip the check.
  const fastT = Date.parse(sealedCekEnvelope.expiresAt)
  if (!Number.isFinite(fastT) || fastT <= Date.now()) {
    throw new SealedRecordExpiredError(sealedCekEnvelope.expiresAt)
  }

  // (2) Unseal → parse binding.
  const payloadBytes = base64ToBuffer(sealedCekEnvelope.payload)
  const openedBytes = await recipientSealer.unseal(payloadBytes)
  const binding = JSON.parse(new TextDecoder().decode(openedBytes)) as SealedCekBinding

  // (3) Binding match — host-denial boundary.
  if (binding.collection !== expectedCollection || binding.id !== expectedId) {
    throw new SealedRecordMismatchError(
      { collection: expectedCollection, id: expectedId },
      { collection: binding.collection, id: binding.id },
    )
  }

  // (4) Authoritative expiry — the copy that cannot be forged on the envelope.
  // Fail CLOSED (M-4): a malformed/empty `expiresAt` → NaN → treat as expired.
  const t = Date.parse(binding.expiresAt)
  if (!Number.isFinite(t) || t <= Date.now()) {
    throw new SealedRecordExpiredError(binding.expiresAt)
  }

  // (5) Import the raw CEK + decrypt the body. Wrong-key (pre-rotation CEK vs
  // post-rotation body) surfaces as TamperedError from decrypt's GCM tag check.
  const cek = await subtle.importKey(
    'raw',
    base64ToBuffer(binding.cek) as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  return decrypt(recordEnvelope._iv, recordEnvelope._data, cek)
}
