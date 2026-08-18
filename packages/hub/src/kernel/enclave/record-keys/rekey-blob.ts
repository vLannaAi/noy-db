/**
 * Re-key a vault's blob set from an old `_blob` DEK to a new one (#1122).
 *
 * ## The defect this closes
 *
 * `rotateKeys` re-keys `store.list(vault, <slot>)` plus the derived refs
 * `derivedRefsFor` declares. That assumes a DEK slot named `X` protects data
 * filed under collection `X`. For `_blob` it is false: the slot is `_blob`, but
 * every byte it protects lives in `_blob_index` and `_blob_chunks`. So rotating
 * `_blob` minted a fresh DEK, re-encrypted **nothing**, and made every blob in
 * the vault permanently unreadable — reported to the user as `TamperedError`,
 * i.e. as an attack, when it was self-inflicted. An ordinary `revoke` of a
 * whole-vault grantee reaches it, because such a grantee's DEK map contains
 * `_blob`.
 *
 * ## Why this cannot be done by `rekeyEnvelopeIfNeeded` alone
 *
 * Two of the three surfaces do not have the shape that helper assumes:
 *
 * - a **chunk** envelope is sealed over raw bytes under a bespoke AAD
 *   (`{eTag}:{index}:{count}`), not under the record AAD, so the generic
 *   helper cannot open it;
 * - an **index** envelope's body is JSON that may itself carry a wrapped
 *   per-blob content CEK (`_cek` / `_cekPending`). Re-encrypting the body under
 *   the new DEK without re-wrapping that CEK leaves a blob whose metadata opens
 *   and whose bytes never will.
 *
 * ## Why it lives in the enclave
 *
 * It reads and writes protected body slots and it unwraps/re-wraps keys — the
 * two things `enclave-body-only` reserves to `kernel/enclave/**`, and the same
 * reason `rekeyEnvelopeToDek` moved here in #1074. `with-party` orchestrates
 * the rotation and must not touch a body to do it.
 *
 * The blob layout below is duplicated from its owner rather than imported:
 * `with-shape/blobs/blob-set.ts` already imports `with-party/team/tiers.js`, so
 * a `with-party → with-shape` import would close a cycle, and the kernel may
 * not depend on a service. `BlobObject` itself is a kernel type, so only the
 * three collection/id string layouts are copied, with their owner named.
 *
 * @packageDocumentation
 */
import {
  encrypt,
  decrypt,
  encryptBytesWithAAD,
  decryptBytesWithAAD,
  wrapCek,
  unwrapCek,
  type EnclaveKey,
} from '../crypto.js'
import { recordAadFor } from '../record-aad.js'
import type { BlobObject, EncryptedEnvelope, NoydbStore } from '../../types.js'

/** Blob metadata envelopes, keyed by eTag. owner: with-shape/blobs/blob-set.ts */
const BLOB_INDEX_COLLECTION = '_blob_index'
/** Chunk envelopes, keyed by `{eTag}_{chunkIndex}`. owner: with-shape/blobs/blob-set.ts */
const BLOB_CHUNKS_COLLECTION = '_blob_chunks'

/**
 * Chunk integrity binding: `{eTag}:{chunkIndex}:{chunkCount}`.
 * Mirrors `chunkAAD` in `with-shape/blobs/blob-set.ts` — the same duplication
 * `with-cargo/extract-partition.ts` already carries, for the same reason.
 */
function chunkAad(eTag: string, index: number, chunkCount: number): Uint8Array {
  return new TextEncoder().encode(`${eTag}:${index}:${chunkCount}`)
}

/**
 * What a rotation did to the blob set.
 *
 * Deliberately NOT on the enclave barrel: no caller outside this module binds
 * it, and that surface is the fork-swap trust boundary, so exporting a type
 * nobody consumes is pure widening.
 *
 * It is a return value rather than a log line because `foreign` and `blobs`
 * are the only way to tell "left alone, correctly" from "left alone, because
 * the caller passed a wrong `otherDeks` set". Both re-key nothing and both
 * return successfully. `rotate-preserves-blobs.test.ts` asserts these counts
 * against a direct call for exactly that reason.
 */
export interface BlobRekeyReport {
  /** Index envelopes moved onto the new DEK. */
  readonly blobs: number
  /** Chunk envelopes re-encrypted under the new DEK. */
  readonly chunks: number
  /**
   * Index envelopes left alone because they open under a DEK the caller holds
   * for a DIFFERENT slot — an elevated blob, sealed under `_blob#<tier>`. Those
   * are that slot's rotation to do, not this one's.
   */
  readonly foreign: number
  /** Index envelopes already under the new DEK — a resumed rotation. */
  readonly alreadyMoved: number
}

/** Did `key` open this envelope's JSON body? */
async function opensJson(
  ref: { collection: string; id: string },
  env: EncryptedEnvelope,
  key: EnclaveKey,
): Promise<string | null> {
  try {
    return await decrypt(env._iv, env._data, key, recordAadFor(ref, env))
  } catch {
    return null
  }
}

/**
 * Move every blob sealed under `oldDek` onto `newDek`.
 *
 * Chunks are re-encrypted BEFORE their index entry is re-sealed, and that order
 * is the resume property: an index entry still readable under `oldDek` means
 * its chunks may be half-moved (each one is probed individually), and an index
 * entry readable under `newDek` means its chunks are already done. An
 * interrupted rotation is finished by re-running it with the same `newDek`.
 *
 * `otherDeks` is what keeps a tier-elevated blob from being mistaken for a
 * damaged one. Membership in `_blob_index` is by DEK, not by collection name:
 * a record elevated to tier N has its blob metadata sealed under `_blob#N`. An
 * envelope that opens under NONE of the keys the caller holds is genuinely
 * unreadable and throws, exactly as `rekeyEnvelopeIfNeeded` does — silently
 * walking past it would turn a loud failure into permanent quiet loss.
 */
export async function rekeyBlobSet(
  adapter: NoydbStore,
  vault: string,
  oldDek: EnclaveKey,
  newDek: EnclaveKey,
  otherDeks: readonly EnclaveKey[] = [],
): Promise<BlobRekeyReport> {
  let blobs = 0
  let chunks = 0
  let foreign = 0
  let alreadyMoved = 0

  let eTags: string[]
  try {
    eTags = await adapter.list(vault, BLOB_INDEX_COLLECTION)
  } catch {
    return { blobs, chunks, foreign, alreadyMoved }
  }

  for (const eTag of eTags) {
    const idxEnv = await adapter.get(vault, BLOB_INDEX_COLLECTION, eTag)
    if (!idxEnv || !idxEnv._iv) continue // no sealed body — nothing to move

    const ref = { collection: BLOB_INDEX_COLLECTION, id: eTag }
    const json = await opensJson(ref, idxEnv, oldDek)
    if (json === null) {
      if ((await opensJson(ref, idxEnv, newDek)) !== null) { alreadyMoved++; continue }
      let claimed = false
      for (const key of otherDeks) {
        if ((await opensJson(ref, idxEnv, key)) !== null) { claimed = true; break }
      }
      if (claimed) { foreign++; continue }
      throw new Error(
        `[noy-db] rotateKeys: blob index entry "${eTag}" opens under neither the retiring `
        + 'nor the new `_blob` DEK, nor any other key this keyring holds. Rotation stopped '
        + 'rather than leaving it unreadable and unreported.',
      )
    }

    const blob = JSON.parse(json) as BlobObject

    // Chunks first. A legacy blob's bytes sit under the `_blob` DEK itself; an
    // erasable blob's sit under its per-blob content CEK and must NOT be
    // touched — re-wrapping that CEK below is the whole of its rotation. A
    // blob interrupted mid-`migrate()` is mixed, so every chunk is probed.
    for (let i = 0; i < blob.chunkCount; i++) {
      const id = `${eTag}_${i}`
      const chunkEnv = await adapter.get(vault, BLOB_CHUNKS_COLLECTION, id)
      if (!chunkEnv || !chunkEnv._iv) continue
      const aad = chunkAad(eTag, i, blob.chunkCount)
      let plain: Uint8Array
      try {
        plain = await decryptBytesWithAAD(chunkEnv._iv, chunkEnv._data, oldDek, aad)
      } catch {
        // A blob that holds a content CEK (settled or pending) keeps its bytes
        // under that CEK, not under the `_blob` DEK — re-wrapping the CEK below
        // is the whole of its rotation, and a chunk that refuses `oldDek` is
        // simply one of those. Nothing to do, and nothing suspicious.
        if (blob._cek !== undefined || blob._cekPending !== undefined) continue
        // Otherwise the blob is legacy: every one of its chunks MUST be under a
        // `_blob` DEK. `newDek` means a previous run already moved this one —
        // verified, not assumed. Neither key means the chunk is damaged, and it
        // throws for the same reason `rekeyEnvelopeIfNeeded` does: the index
        // entry opened fine under `oldDek` and says nothing about its chunks, so
        // continuing here would walk past unreadable data and report success.
        try {
          await decryptBytesWithAAD(chunkEnv._iv, chunkEnv._data, newDek, aad)
          continue
        } catch {
          throw new Error(
            `[noy-db] rotateKeys: blob chunk "${id}" (${i + 1}/${blob.chunkCount} of eTag `
            + `"${eTag}") opens under neither the retiring nor the new \`_blob\` DEK, and its `
            + 'blob holds no content CEK that could explain it. Rotation stopped rather than '
            + 'leaving it unreadable and unreported.',
          )
        }
      }
      const { iv, data } = await encryptBytesWithAAD(plain, newDek, aad)
      await adapter.put(vault, BLOB_CHUNKS_COLLECTION, id, { ...chunkEnv, _iv: iv, _data: data })
      chunks++
    }

    // The wrapped content CEKs travel with the metadata: they are wrapped under
    // the `_blob` DEK, so a rotation that re-encrypted the body and left them
    // alone would produce metadata that opens and bytes that never do.
    const rewrapped: BlobObject = {
      ...blob,
      ...(blob._cek !== undefined
        ? { _cek: await wrapCek(await unwrapCek(blob._cek, oldDek), newDek) }
        : {}),
      ...(blob._cekPending !== undefined
        ? { _cekPending: await wrapCek(await unwrapCek(blob._cekPending, oldDek), newDek) }
        : {}),
    }

    const { iv, data } = await encrypt(JSON.stringify(rewrapped), newDek, recordAadFor(ref, idxEnv))
    await adapter.put(vault, BLOB_INDEX_COLLECTION, eTag, { ...idxEnv, _iv: iv, _data: data })
    blobs++
  }

  return { blobs, chunks, foreign, alreadyMoved }
}
