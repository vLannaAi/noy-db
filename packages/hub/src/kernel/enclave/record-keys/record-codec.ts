/**
 * RecordCodec — the per-record envelope build + encrypt/decrypt + per-record-CEK
 * + sealed-field crypto.
 *
 * `Collection` holds one `RecordCodec` instance and delegates the crypto write
 * path (`encryptRecord` / `encryptJsonString` / `buildDebugEnvelope`), the read
 * path (`decryptRecord` / `decryptJsonString` / `resolveEnvelopeCek`), and the
 * sealed-field helpers (`unsealField` / `makeSealedHandle` / `toCacheRecord` /
 * `classifySealedShred`) to it. The codec receives every `this.*` dependency
 * it needs via {@link RecordCodecContext}.
 *
 * The crux is `cekCache`: it is the SAME `Lru` reference `Collection` owns (not
 * a copy). `resolveEnvelopeCek` reads/writes it, and tier methods +
 * `vault.invalidateRecordCaches` keep mutating that same object — a copy would
 * silently break the "single CEK delete kills the version chain" invariant.
 *
 * Internal service — not exported as a `@noy-db/hub/*` subpath.
 */
import { encrypt, decrypt, encryptDeterministic, deriveDeterministicKey, wrapCek, unwrapCek, deriveSealedFieldKey, deriveSealedFieldKeyFromCek, type EnclaveKey } from '../crypto.js'
import { NOYDB_FORMAT_VERSION, SealedHandle, type EncryptedEnvelope, type CrdtMode, type CrdtState, type CrdtStrategy, type VdigFieldPolicy } from '../../types.js'
import { isTombstone } from './tombstone.js'
import { parseSealedSlot, dualReadSealedSlot } from './sealed-slot.js'
import { DebugReservedFieldError, ClassifiedConfigError, ValidationError } from '../../errors.js'
import { mintVdigSlot } from '../classify/write.js'
import { validateSchemaOutput, type StandardSchemaV1 } from '../../schema.js'
import type { Lru } from '../../cache/index.js'

/** Everything the moving crypto methods touched on `this.*`, as a flat context. */
export interface RecordCodecContext<T> {
  /** Collection name — the crypto AAD scope and schema-error context. */
  readonly name: string
  /** Actor id stamped on `_by` (the collection's keyring.userId). */
  readonly actor: string
  /** False on plaintext collections — selects the no-ciphertext envelope branch. */
  readonly storeCiphertext: boolean
  /** keyring.debugPlaintext — debug-inline envelope on user collections. */
  readonly debugPlaintext: boolean
  /** Emit `_source`/`_sourceTs` provenance fields when a source is supplied. */
  readonly provenance: boolean
  /** Declared `sensitive` fields → sealed into `_sealed[field]`. */
  readonly sensitiveFields: ReadonlySet<string>
  /** Declared deterministic-index fields, or null. */
  readonly deterministicFields: ReadonlySet<string> | null
  /** Digest-only classified fields → verify policy (stage 2). Null when none. */
  readonly vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null
  /** CRDT mode (decrypt resolves CrdtState→snapshot when set). */
  readonly crdtMode: CrdtMode | undefined
  /** CRDT strategy seam (resolveCrdtSnapshot). */
  readonly crdtStrategy: CrdtStrategy
  /** Output-schema validator, or undefined. */
  readonly schema: StandardSchemaV1<unknown, T> | undefined
  /** The collection DEK (codec only ever needs this.name's DEK). */
  getDEK(): Promise<EnclaveKey>
  /**
   * The collection's per-record CEK cache (SHARED reference, not a copy).
   * Ownership/lifetime stays on Collection; codec reads+writes it in
   * resolveEnvelopeCek exactly as the inline code did. `null` → no caching.
   */
  readonly cekCache: Lru<string, EnclaveKey> | null
}

export class RecordCodec<T> {
  constructor(private readonly ctx: RecordCodecContext<T>) {}

  // ──────────────────────────────────────────────────────────────────────
  // Low-level literal builders
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Assemble a canonical ciphertext body envelope literal from already-computed
   * parts. Pure, no crypto. Each call stamps its own `_ts` — provenance carries
   * a SEPARATE timestamp (computed by the caller), so the two never share one.
   */
  static buildEnvelope(p: {
    version: number
    iv: string
    data: string
    by?: string
    cek?: string
    provenance?: { source: string; sourceTs: string } | undefined
    extra?: Partial<Pick<EncryptedEnvelope, '_tier' | '_det' | '_sealed'>>
  }): EncryptedEnvelope {
    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: p.version,
      _ts: new Date().toISOString(),
      _iv: p.iv,
      _data: p.data,
      ...(p.by !== undefined ? { _by: p.by } : {}),
      ...(p.cek !== undefined ? { _cek: p.cek } : {}),
      ...(p.provenance !== undefined ? { _source: p.provenance.source, _sourceTs: p.provenance.sourceTs } : {}),
      ...(p.extra ?? {}),
    }
  }

  /** Plaintext (`_iv:''`) body envelope — the `!storeCiphertext` shape. */
  static buildPlaintextEnvelope(p: {
    version: number
    data: string
    by?: string
    provenance?: { source: string; sourceTs: string } | undefined
  }): EncryptedEnvelope {
    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: p.version,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: p.data,
      ...(p.by !== undefined ? { _by: p.by } : {}),
      ...(p.provenance !== undefined ? { _source: p.provenance.source, _sourceTs: p.provenance.sourceTs } : {}),
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Write path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Build a debug-plaintext envelope: the record's own fields inlined as
   * top-level keys beside the reserved `_`-metadata, with `_debug: 1` and an
   * empty `_data`. Lets native store tooling read the record without
   * unwrapping. Only reached for user collections under `debugPlaintext`
   * (see {@link encryptRecord}). Rejects `_`-prefixed record fields, which
   * would collide with the reserved metadata namespace.
   */
  buildDebugEnvelope(record: T, version: number, source?: string, sourceTs?: string): EncryptedEnvelope {
    const rec = record as unknown as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      if (key.startsWith('_')) throw new DebugReservedFieldError(this.ctx.name, key)
    }
    return {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: version,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: '',
      _by: this.ctx.actor,
      _debug: NOYDB_FORMAT_VERSION,
      ...(this.ctx.provenance && source !== undefined ? { _source: source, _sourceTs: sourceTs ?? new Date().toISOString() } : {}),
      ...rec,
    } as unknown as EncryptedEnvelope
  }

  /**
   * Encrypt a JSON body into an envelope.
   *
   * When `cek` is supplied (per-record CEK collections), the body is
   * encrypted under the CEK and the CEK is AES-KW-wrapped under the
   * collection DEK and stamped on `_cek`. When `cek` is omitted, the legacy
   * path encrypts the body directly under the collection DEK — byte-identical
   * to pre-CEK behaviour, so non-adopting collections pay nothing.
   */
  async encryptJsonString(
    json: string,
    version: number,
    cek?: EnclaveKey,
    source?: string,
    sourceTs?: string,
  ): Promise<EncryptedEnvelope> {
    const by = this.ctx.actor
    const provenance = this.ctx.provenance && source !== undefined
      ? { source, sourceTs: sourceTs ?? new Date().toISOString() }
      : undefined

    if (!this.ctx.storeCiphertext) {
      return RecordCodec.buildPlaintextEnvelope({ version, data: json, by, provenance })
    }

    const dek = await this.ctx.getDEK()

    if (cek !== undefined) {
      const { iv, data } = await encrypt(json, cek)
      const wrapped = await wrapCek(cek, dek)
      return RecordCodec.buildEnvelope({ version, iv, data, by, cek: wrapped, provenance })
    }

    const { iv, data } = await encrypt(json, dek)
    return RecordCodec.buildEnvelope({ version, iv, data, by, provenance })
  }

  async encryptRecord(
    record: T,
    version: number,
    cek?: EnclaveKey,
    source?: string,
    sourceTs?: string,
    vdig?: { readonly id: string; readonly prev: EncryptedEnvelope | null },
  ): Promise<EncryptedEnvelope> {
    // Debug-plaintext: write user-collection records with their fields inlined
    // beside the envelope metadata so native store tools read them directly.
    // Internal (`_`-prefixed) collections keep the classic shape — some store
    // `_`-prefixed fields that the inline layout would collide with.
    if (!this.ctx.storeCiphertext && this.ctx.debugPlaintext && !this.ctx.name.startsWith('_')) {
      return this.buildDebugEnvelope(record, version, source, sourceTs)
    }

    // Structural group-encryption: peel declared sensitive fields out
    // of the record BEFORE building `_data`, sealing each into its own
    // `_sealed[field]` slot under a per-field key. Default-off — with no
    // sensitive fields the open record is unchanged and no `_sealed` is
    // emitted, so the envelope stays byte-identical to legacy output.
    let openRecord = record
    let sealed: Record<string, string> | undefined
    if (this.ctx.storeCiphertext && this.ctx.sensitiveFields.size > 0) {
      const src = record as unknown as Record<string, unknown>
      const dek = await this.ctx.getDEK()
      const open: Record<string, unknown> = { ...src }
      const slots: Record<string, string> = {}
      for (const field of this.ctx.sensitiveFields) {
        if (!(field in src)) continue
        const value = src[field]
        if (value === undefined) continue
        const fieldKey = cek !== undefined
          ? await deriveSealedFieldKeyFromCek(cek, this.ctx.name, field)
          : await deriveSealedFieldKey(dek, this.ctx.name, field)
        const { iv, data } = await encrypt(JSON.stringify(value), fieldKey)
        slots[field] = `${iv}:${data}`
        delete open[field]
      }
      if (Object.keys(slots).length > 0) {
        sealed = slots
        openRecord = open as unknown as T
      }
    }

    // ── Digest-only classified fields (stage 2, C6) ────────────────────
    // Per field, exactly one of: carry-forward (absent) / rotate (string) /
    // clear (null) / loud error (anything else). Runs on a CLONE so the
    // caller's record object is never mutated.
    let vdigOut: Record<string, string> | undefined
    if (this.ctx.vdigFields !== null && this.ctx.vdigFields.size > 0 && this.ctx.storeCiphertext) {
      if (vdig === undefined) {
        throw new Error(
          `RecordCodec.encryptRecord: collection "${this.ctx.name}" declares digest-only classified ` +
          `fields but this write path supplied no { id, prev } context — it would silently destroy _vdig (C6). Caller bug.`,
        )
      }
      if (cek === undefined) {
        throw new Error(
          `RecordCodec.encryptRecord: digest-only fields require a per-record CEK (R1 invariant) — ` +
          `collection "${this.ctx.name}" wrote without one. Caller bug.`,
        )
      }
      const open: Record<string, unknown> = { ...(openRecord as unknown as Record<string, unknown>) }
      const out: Record<string, string> = {}
      for (const [field, policy] of this.ctx.vdigFields) {
        const value = open[field]
        const prevBlob = vdig.prev?._vdig?.[field]
        if (vdig.prev?._sealed?.[field] !== undefined) {
          // R6 transition evidence: never silently delete recoverable
          // plaintext. Checked BEFORE the value-type dispatch so the
          // carry-forward (absent) and clear (null) branches refuse too —
          // both would otherwise drop the `_sealed` slot from the new
          // envelope, silently destroying the recoverable ciphertext.
          throw new ClassifiedConfigError(
            this.ctx.name,
            `field "${field}" carries a recoverable _sealed slot from a previous storage form — ` +
            `recoverable ↔ digest-only transitions are refused (R6); migrate explicitly`,
          )
        }
        if (value === undefined) {
          // 1. carry-forward: verbatim bytes (CEK version-stable, AAD _v-free;
          //    byte-identity keeps the ledger payload hash deterministic).
          if (prevBlob !== undefined) out[field] = prevBlob
          continue
        }
        if (value === null) {
          // 3. clear: the defined deletion short of forget().
          delete open[field]
          continue
        }
        if (typeof value !== 'string') {
          // 4. caller bug, fail-loud.
          throw new ValidationError(
            `digest-only classified field "${field}" in "${this.ctx.name}" must be a string (rotate) or null (clear), got ${typeof value}`,
          )
        }
        // 2. rotate: validate ran in the stage-1 write seam; digest + ring here.
        out[field] = await mintVdigSlot(value, policy, prevBlob, cek, this.ctx.name, vdig.id, field)
        delete open[field] // strip from _data — digest-only never persists plaintext
      }
      openRecord = open as unknown as T
      if (Object.keys(out).length > 0) vdigOut = out
    }

    const base = await this.encryptJsonString(JSON.stringify(openRecord), version, cek, source, sourceTs)
    const withSealed = sealed ? { ...base, _sealed: sealed } : base
    const withVdig = vdigOut ? { ...withSealed, _vdig: vdigOut } : withSealed
    if (!this.ctx.deterministicFields || !this.ctx.storeCiphertext) return withVdig

    // compute deterministic-ciphertext slots for every
    // declared field. Non-primitive values are JSON-stringified so
    // objects/arrays still dedupe on structural equality. Sealed fields are
    // excluded — they live only in `_sealed`, never the `_det` index.
    // L-1: `_det` encrypts under a dedicated HKDF-derived key (salt
    // `noydb-det`), never the raw DEK — the DEK's randomized-IV `_data`
    // regime and `_det`'s deterministic-IV regime must not share a key.
    const dek = await this.ctx.getDEK()
    const detKey = await deriveDeterministicKey(dek)
    const rec = record as unknown as Record<string, unknown>
    const det: Record<string, string> = {}
    for (const field of this.ctx.deterministicFields) {
      if (this.ctx.sensitiveFields.has(field)) continue
      if (this.ctx.vdigFields?.has(field)) continue // I5: digest-only never equality-correlatable
      const value = rec[field]
      if (value === undefined || value === null) continue
      const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
      const { iv, data } = await encryptDeterministic(plaintext, detKey, `${this.ctx.name}/${field}`)
      det[field] = `${iv}:${data}`
    }
    if (Object.keys(det).length === 0) return withVdig
    return { ...withVdig, _det: det }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Read path
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Resolve the per-record CEK for a stored envelope, or `undefined` for a
   * legacy (`_cek`-absent) envelope. Unwraps `_cek` under the collection DEK and
   * memoises it in the CEK cache under `id` (when supplied) so repeated reads of
   * the same record skip the unwrap. Shared by the body-decrypt path
   * ({@link decryptJsonString}) and the sealed-field path ({@link decryptRecord}
   * / {@link toCacheRecord}) so both agree on the record's key.
   */
  async resolveEnvelopeCek(envelope: EncryptedEnvelope, id?: string): Promise<EnclaveKey | undefined> {
    if (envelope._cek === undefined) return undefined
    const cached = id !== undefined ? this.ctx.cekCache?.get(id) : undefined
    if (cached !== undefined) return cached
    const dek = await this.ctx.getDEK()
    const cek = await unwrapCek(envelope._cek, dek)
    if (id !== undefined) this.ctx.cekCache?.set(id, cek, 1)
    return cek
  }

  /**
   * Low-level: decrypt an envelope and return the raw JSON string.
   *
   * `_cek` presence is the format discriminant (NOT `this.perRecordCek`),
   * so a mixed vault — and a recipient that never opted into
   * `perRecordKeys` — decrypts both legacy and CEK records:
   *  - `_cek` present → unwrap the CEK under the collection DEK, decrypt the
   *    body under the CEK (cache the unwrapped CEK so repeated reads skip it).
   *  - `_cek` absent → legacy path, body decrypts directly under the
   *    collection DEK.
   *
   * The optional `id` lets reads populate the CEK cache; it is omitted by
   * callers (history, conflict merge) that have only the envelope.
   */
  async decryptJsonString(envelope: EncryptedEnvelope, id?: string): Promise<string | null> {
    // RISK #1 (forget cascade): a shred tombstone carries `_data: ''` and no
    // `_cek`. Decrypting it would call `decrypt('', '', dek)` → AES-GCM
    // OperationError → TamperedError. Return null so every read callsite
    // treats it as "absent / skip", matching how get()/list already drop
    // tombstones. Legacy plaintext collections (`!this.storeCiphertext`) legitimately
    // have empty `_iv`/`_data`, so `isTombstone` is false for them — preserved.
    if (isTombstone(envelope, this.ctx.storeCiphertext)) return null
    if (!this.ctx.storeCiphertext) {
      // Debug-plaintext layout: record fields were inlined as top-level keys
      // (see buildDebugEnvelope). Reconstruct the record from the non-`_`
      // keys. Self-describing via `_debug`, so a classic plaintext reader
      // handles debug-written envelopes too.
      if (envelope._debug !== undefined) {
        const rec: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(envelope)) {
          if (!key.startsWith('_')) rec[key] = value
        }
        return JSON.stringify(rec)
      }
      return envelope._data
    }
    const cek = await this.resolveEnvelopeCek(envelope, id)
    if (cek !== undefined) return decrypt(envelope._iv, envelope._data, cek)
    const dek = await this.ctx.getDEK()
    return decrypt(envelope._iv, envelope._data, dek)
  }

  /**
   * Unseal a single `_sealed[field]` slot to its plaintext value: derive the
   * per-field key off the collection DEK, AES-GCM-decrypt the `iv:data` blob,
   * and JSON-parse the result. Shared by both the inline-decrypt path and a
   * {@link Sealed} handle's `reveal()` — so the on-demand reveal and the eager
   * materialisation always agree byte-for-byte.
   */
  async unsealField(field: string, blob: string, cek?: EnclaveKey): Promise<unknown> {
    // Dual-read. Current writes seal under a key derived from the record's
    // per-record CEK; legacy records (even ones whose body is
    // CEK-encrypted) are sealed under the collection-DEK key. Try the CEK key
    // first; on its AES-GCM auth failure, fall back to the DEK key. Without this
    // fallback every legacy `_sealed` record would throw TamperedError (data loss).
    const dek = await this.ctx.getDEK()
    return JSON.parse(await dualReadSealedSlot(blob, field, this.ctx.name, cek, dek))
  }

  /**
   * Classify a live envelope's `_sealed` slots for crypto-shred completeness.
   * `forget()` drops `_cek`/`_sealed` but
   * RETAINS the collection DEK, so only a slot keyed off the per-record CEK is
   * genuinely shredded by the tombstone; a legacy slot keyed off the
   * collection DEK survives in any synced/backup copy.
   *
   * Mirrors {@link unsealField}'s dual-read split: try the CEK-derived key per
   * slot — success → `shreddable`, AES-GCM auth failure → `dekResidue`. With no
   * `_cek` (pure legacy collection-DEK sealing) ALL slots are residue.
   */
  async classifySealedShred(
    live: EncryptedEnvelope,
  ): Promise<{ shreddable: string[]; dekResidue: string[] }> {
    const shreddable: string[] = []
    const dekResidue: string[] = []
    // Verify-digest slots are CEK-only by construction (I3): dropping `_cek`
    // makes every `_vdig[field]` permanently undecryptable — shreddable
    // unconditionally, no vdig-dekResidue class (spec §2 forget()). Same
    // honesty caveats as #306 D5 for synced/backup copies of the ciphertext.
    if (live._vdig !== undefined && live._cek !== undefined) {
      shreddable.push(...Object.keys(live._vdig))
    }
    const sealed = live._sealed
    if (sealed === undefined) return { shreddable, dekResidue }
    const cek = await this.resolveEnvelopeCek(live)
    for (const [field, blob] of Object.entries(sealed)) {
      if (cek === undefined) { dekResidue.push(field); continue }
      const { iv, data } = parseSealedSlot(blob)
      try {
        await decrypt(iv, data, await deriveSealedFieldKeyFromCek(cek, this.ctx.name, field))
        shreddable.push(field)
      } catch {
        dekResidue.push(field)
      }
    }
    return { shreddable, dekResidue }
  }

  /**
   * Build a non-leaking {@link Sealed} handle over a sealed field's ciphertext.
   * The handle captures only the ciphertext `blob` and a closure to
   * {@link unsealField}; the plaintext is never stored on it — so the handle
   * may sit in the working-set cache (or be logged/serialised) without
   * exposing the value, which decrypts only on `reveal()`.
   */
  makeSealedHandle(field: string, blob: string, cek?: EnclaveKey): SealedHandle<unknown> {
    return new SealedHandle(() => this.unsealField(field, blob, cek))
  }

  /**
   * Replace a record's declared sensitive fields with {@link Sealed} handles
   * built from the just-written envelope's `_sealed` slots, leaving every
   * other field as its plaintext value. Used to populate the cache on the
   * write path without ever materialising sealed plaintext into it. Returns
   * `record` untouched when the collection seals nothing.
   */
  async toCacheRecord(record: T, envelope: EncryptedEnvelope, id?: string): Promise<T> {
    const sealed = envelope._sealed
    if (sealed === undefined || !this.ctx.storeCiphertext || this.ctx.sensitiveFields.size === 0) {
      return record
    }
    const cek = await this.resolveEnvelopeCek(envelope, id)
    const clone = { ...(record as unknown as Record<string, unknown>) }
    for (const [field, blob] of Object.entries(sealed)) {
      clone[field] = this.makeSealedHandle(field, blob, cek)
    }
    return clone as unknown as T
  }

  /**
   * Decrypt an envelope into a record of type `T`.
   *
   * When a schema is attached, the decrypted value is validated before
   * being returned. A divergence between the stored bytes and the
   * current schema throws `SchemaValidationError` with
   * `direction: 'output'` — silently returning drifted data would
   * propagate garbage into the UI and break the whole point of having
   * a schema.
   *
   * `skipValidation` exists for history reads: when calling
   * `getVersion()` the caller is explicitly asking for an old snapshot
   * that may predate a schema change, so validating it would be a
   * false positive. Every non-history read leaves this flag `false`.
   */
  async decryptRecord(
    envelope: EncryptedEnvelope,
    opts: { skipValidation?: boolean; id?: string; sealedAsHandles?: boolean } = {},
  ): Promise<T | null> {
    const json = await this.decryptJsonString(envelope, opts.id)
    // Tombstone (shredded record) → null, propagated from decryptJsonString.
    // Callers skip null exactly as they already skip a tombstone envelope.
    if (json === null) return null
    let parsed: unknown = JSON.parse(json)

    // CRDT resolution: if this collection is in CRDT mode, the
    // stored JSON is a CrdtState, not T directly. Resolve to the snapshot.
    if (this.ctx.crdtMode && parsed !== null && typeof parsed === 'object' && '_crdt' in parsed) {
      parsed = this.ctx.crdtStrategy.resolveCrdtSnapshot(parsed as CrdtState)
    }

    let record = parsed as T

    // Structural group-encryption + sealed access gate.
    // Each `_sealed[field]` slot is restored under its own per-field key.
    // `sealedAsHandles: false` (default — internal callers that compute on
    // real values) inline-decrypts to the plaintext value; `true` (the
    // public / cache path) yields an opaque {@link Sealed} handle so the
    // plaintext is never materialised into the working-set cache.
    if (envelope._sealed !== undefined && this.ctx.storeCiphertext) {
      const sealedCek = await this.resolveEnvelopeCek(envelope, opts.id)
      const target = record as unknown as Record<string, unknown>
      for (const [field, blob] of Object.entries(envelope._sealed)) {
        target[field] = opts.sealedAsHandles
          ? this.makeSealedHandle(field, blob, sealedCek)
          : await this.unsealField(field, blob, sealedCek)
      }
    }

    // Skip output validation when sealed fields are returned as handles:
    // the record carries opaque `Sealed` handles in place of the declared
    // values, so a whole-record schema check would false-positive on them.
    // (The values were validated on input/write; the open fields are
    // unchanged from the validated body.) The inline-value path below still
    // validates fully.
    const sealedAsHandles = opts.sealedAsHandles === true && envelope._sealed !== undefined
    if (this.ctx.schema !== undefined && !opts.skipValidation && !sealedAsHandles) {
      // Context string deliberately avoids leaking the record id — the
      // envelope only carries the version, not the id (the id lives in
      // the adapter-side key). `<collection>@v<n>` is enough for the
      // developer to find the offending record.
      record = await validateSchemaOutput(
        this.ctx.schema,
        record,
        `${this.ctx.name}@v${envelope._v}`,
      )
    }

    return record
  }
}
