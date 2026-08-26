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
import { encrypt, decrypt, encryptDeterministic, deriveDeterministicKey, wrapCek, unwrapCek, deriveSealedFieldKeyFromCek, type EnclaveKey } from '../crypto.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope, type CrdtMode, type CrdtState, type CrdtStrategy, type VdigFieldPolicy, type SealedHandle } from '../../types.js'
import { isTombstone, isDeleteMarker } from './tombstone.js'
import { parseSealedSlot } from './sealed-slot.js'
import { buildRecordEnvelope } from '../record-envelope.js'
import { buildRecordAad, recordAadFor, type RecordIdentity, type RecordRef } from '../record-aad.js'
import { sealFields, unsealOneField, unsealFields, makeHandleProducer, makeSealedSlotCapability, makeReservedEnvelopes, type SealKeyMaterial } from './sealed-slots.js'
import { DebugReservedFieldError, ClassifiedConfigError, ValidationError } from '../../errors.js'
import { mintVdigSlot } from '../classify/write.js'
import { mintBidxTag } from '../classify/bidx.js'
import { normalizeForVerify } from '../classify/normalize.js'
import { validateSchemaOutput, type StandardSchemaV1 } from '../../schema.js'
import type { Lru } from '../../cache/index.js'
import type { ViaCryptoCtx, SealedSlotRef } from '../../via/index.js'
import type { ViaPipeline } from '../../via/pipeline.js'

/**
 * One classified per-slot verdict from {@link RecordCodec.classifySealedShred}.
 * `shreddable` — CEK-only, tombstone makes it undecryptable. `dekResidue` —
 * collection-DEK-keyed, survives in synced/backup copies. The third class is
 * BOTH: a `_bidx` blind-index tag is live-dropped by the tombstone yet retained
 * under the surviving DEK in any pre-forget backup (honest dual accounting).
 */
export type SealedShredSlot = {
  readonly field: string
  readonly class: 'shreddable' | 'dekResidue' | 'live-shreddable+dekResidue-in-backups'
}

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
  /**
   * C-A / R10 config-drift signal: the persisted `x-classified` marker's
   * declared digest-only field set (empty when the collection carries no
   * marker). Lazy, memoized (O(1) per handle after the first call). The R10
   * superset guard refuses whenever a field in this set is absent from
   * `vdigFields`. Consulted once per handle on any encrypted write path — the
   * cross-session, prev-free signal a fully-naive create has no `prev` for.
   * Undefined on codecs with no store access (direct-construction tests).
   */
  classifiedMarkerDigestOnly?(): Promise<readonly string[]>
  /** CRDT mode (decrypt resolves CrdtState→snapshot when set). */
  readonly crdtMode: CrdtMode | undefined
  /** CRDT strategy seam (resolveCrdtSnapshot). */
  readonly crdtStrategy: CrdtStrategy
  /** Output-schema validator, or undefined. */
  readonly schema: StandardSchemaV1<unknown, T> | undefined
  /**
   * Resolve a collection's DEK. Called with no argument for `this.name`'s
   * own DEK (every ordinary codec use); `viaCryptoCtx`'s `reservedEnvelopes`
   * door passes an explicit OTHER collection name (e.g. a reserved
   * `_dict_status` collection) so a binding's at-rest hook can address a
   * different collection's DEK without ever holding the resolver itself.
   */
  getDEK(collection?: string): Promise<EnclaveKey>
  /**
   * The collection's per-record CEK cache (SHARED reference, not a copy).
   * Ownership/lifetime stays on Collection; codec reads+writes it in
   * resolveEnvelopeCek exactly as the inline code did. `null` → no caching.
   */
  readonly cekCache: Lru<string, EnclaveKey> | null
  /**
   * Compiled Via pipeline (money, i18n, …), or undefined for a collection
   * with none declared. `encryptRecord`/`decryptRecord` consult
   * `via?.hasAtRestHooks` at the sealed-slot sub-step to choose between a
   * binding's `encodeAtRest`/`decodeAtRest` hooks and today's inline path.
   * The zero-via fast path (`via` undefined, or no binding declares an
   * at-rest hook) stays byte/behavior-identical (#629 Task 3).
   *
   * Mutable (not `readonly`, #638 Task 3): `Collection.via` can be
   * reassigned post-construction (the taint overlay, `via/graph-wiring.ts#
   * applyTaintOverlay`) — `RecordCodec.setVia` below keeps this in sync so
   * at-rest hooks read the LIVE pipeline, not a stale construction-time
   * snapshot.
   */
  via: ViaPipeline | undefined
}

export class RecordCodec<T> {
  constructor(private readonly ctx: RecordCodecContext<T>) {}

  /**
   * @internal Update the live Via pipeline this codec's at-rest hooks read
   * (#638 Task 3) — called by `via/graph-wiring.ts#applyTaintOverlay` right
   * after it reassigns `Collection.via`, so `hasAtRestHooks`/`encodeAtRest`/
   * `decodeAtRest` see the newly-added `taint` binding instead of the
   * pipeline snapshot captured when this codec was constructed.
   */
  setVia(via: ViaPipeline | undefined): void {
    this.ctx.via = via
  }

  /** Sealed-slot key material for this codec's collection, for a given per-record CEK (or none). */
  private sealKeyMaterial(cek: EnclaveKey | undefined): SealKeyMaterial {
    return {
      collection: this.ctx.name,
      ...(cek !== undefined ? { cek } : {}),
      getDEK: () => this.ctx.getDEK(),
    }
  }

  /**
   * Build the `ViaCryptoCtx` handed to a binding's `encodeAtRest`/
   * `decodeAtRest` hook: `sealedSlots` pre-bound to `(this.ctx.name,
   * recordId)` — always threading `cek` when the caller has one, so the
   * capability's record-binding stays cryptographic rather than degrading
   * to collection-scope. `reservedEnvelopes`'s DEK resolver forwards its
   * `collection` argument straight to `this.ctx.getDEK` (#629 Task 4) — it
   * resolves the RESERVED collection's own DEK (e.g. `_dict_status`), never
   * `this.ctx.name`'s, matching `Vault.getDEK`'s per-collection-name
   * resolution (the same resolver `DictionaryHandle` used pre-cutover).
   */
  private viaCryptoCtx(recordId: string, cek: EnclaveKey | undefined): ViaCryptoCtx {
    const declaredPrefixes = this.ctx.via?.bindings.flatMap((b) => b.reservedPrefixes ?? []) ?? []
    return {
      sealedSlots: makeSealedSlotCapability(this.ctx, recordId, cek),
      reservedEnvelopes: makeReservedEnvelopes((collection) => this.ctx.getDEK(collection), declaredPrefixes),
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Low-level literal builders
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Assemble a canonical ciphertext body envelope literal from already-computed
   * parts. Pure, no crypto. Each call stamps its own `_ts` — provenance carries
   * a SEPARATE timestamp (computed by the caller), so the two never share one.
   */
  static buildEnvelope(identity: RecordIdentity, p: {
    iv: string
    data: string
    // No `by` — `_by` is stamped from `identity`, the single source (#1041).
    // It was declared here and silently ignored, which is exactly how a
    // dropped field hides.
    cek?: string
    provenance?: { source: string; sourceTs: string } | undefined
    extra?: Partial<Pick<EncryptedEnvelope, '_tier' | '_det' | '_sealed'>>
  }): EncryptedEnvelope {
    return buildRecordEnvelope(identity, p)
  }

  /** Plaintext (`_iv:''`) body envelope — the `!storeCiphertext` shape. */
  static buildPlaintextEnvelope(identity: RecordIdentity, p: {
    data: string
    provenance?: { source: string; sourceTs: string } | undefined
  }): EncryptedEnvelope {
    return buildRecordEnvelope(identity, { ...p, iv: '' })
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
  buildDebugEnvelope(id: string, record: T, version: number, source?: string, sourceTs?: string): EncryptedEnvelope {
    const rec = record as unknown as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      if (key.startsWith('_')) throw new DebugReservedFieldError(this.ctx.name, key)
    }
    const base = buildRecordEnvelope(
      { collection: this.ctx.name, id, by: this.ctx.actor, version },
      {
        iv: '',
        data: '',
        
        ...(this.ctx.provenance && source !== undefined
          ? { provenance: { source, sourceTs: sourceTs ?? new Date().toISOString() } }
          : {}),
      },
    )
    // `_debug` and the inlined record fields are this envelope's own shape —
    // they are not part of the canonical constructor's contract.
    return { ...base, _debug: NOYDB_FORMAT_VERSION, ...rec } as unknown as EncryptedEnvelope
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
  /**
   * `ref` is the identity the envelope is sealed against, and it is **the
   * location the bytes are stored at** — not necessarily this codec's own
   * collection (#1051).
   *
   * That distinction was discovered here rather than assumed. Several callers
   * put the result somewhere else entirely: search's vector sidecar lands in
   * `_vec` under `encodeVecId(name, id)`, the lexical index under `_ft/<name>`,
   * indexing's entries under a synthetic `idxId`. A codec that supplied
   * `this.ctx.name` for those would seal them against a collection they are not
   * in, and once AAD binds identity every one of them would fail to verify.
   *
   * ⚠️ **`_history` is the open case, and it is #1041's to settle.** Snapshots
   * are produced with the LIVE record's identity here and then re-homed by
   * `saveHistory` into `_history/<historyId(collection,id,_v)>`. Both readings
   * are defensible — bind where it lives, or bind what it is a copy of — and
   * the choice must be made before AAD is switched on, not inferred from this
   * migration.
   */
  async encryptJsonString(
    ref: RecordRef,
    json: string,
    version: number,
    cek?: EnclaveKey,
    source?: string,
    sourceTs?: string,
  ): Promise<EncryptedEnvelope> {
    // No envelope may be sealed over a non-string plaintext (#1220).
    // `JSON.stringify(undefined)` is `undefined`, so a caller that passes an
    // undefined record seals over NOTHING: `_data` is a bare GCM tag over zero
    // ciphertext. The envelope is well-formed and correctly sealed, which is
    // why nothing downstream catches it — it reads back as `undefined` on the
    // cached path (measured; note that is off `get()`'s declared `T | null`,
    // so `rec === null` misses it too) and as a `SyntaxError` out of
    // `decryptRecord` on the hydrate path. Two failures that both point away
    // from the write that caused them, and neither is `null`, which is what a
    // genuinely absent id returns.
    // Stated on the OUTPUT condition so it holds for every caller, not just
    // the `put(record)` arity slip that surfaced it.
    if (typeof json !== 'string') {
      throw new TypeError(
        `record seal: plaintext must be a string for "${String(ref.collection)}/${String(ref.id)}", ` +
        `received ${String(json)} (${typeof json}). Sealing over an empty plaintext produces ` +
        `an envelope that is valid and undecodable.`,
      )
    }
    // `version` folds into the identity HERE rather than travelling beside it,
    // so what is sealed and what is stamped come from one object (#1093).
    const identity: RecordIdentity = { ...ref, version, by: this.ctx.actor }
    const provenance = this.ctx.provenance && source !== undefined
      ? { source, sourceTs: sourceTs ?? new Date().toISOString() }
      : undefined

    if (!this.ctx.storeCiphertext) {
      return RecordCodec.buildPlaintextEnvelope(identity, { data: json, provenance })
    }

    const dek = await this.ctx.getDEK()

    const aad = buildRecordAad(identity)

    if (cek !== undefined) {
      const { iv, data } = await encrypt(json, cek, aad)
      const wrapped = await wrapCek(cek, dek)
      return RecordCodec.buildEnvelope(identity, { iv, data, cek: wrapped, provenance })
    }

    const { iv, data } = await encrypt(json, dek, aad)
    return RecordCodec.buildEnvelope(identity, { iv, data, provenance })
  }

  /**
   * `ref` is FIRST and required (#1051). It was previously a trailing optional
   * `id?: string`, which TypeScript cannot promote to required because it sits
   * after other optionals — so the migration would have needed an `id ?? ''`
   * fallback. That is exactly the silent default this issue exists to remove:
   * once identity is bound into the AEAD, every record written with an empty id
   * binds to the SAME identity and becomes interchangeable with the others.
   * An object, not a bare string, so a swap with `version`/`source` cannot
   * compile on the hottest write path. Carries the collection too — see
   * {@link encryptJsonString} for why the codec must not assume its own.
   */
  async encryptRecord(
    ref: RecordRef,
    record: T,
    version: number,
    cek?: EnclaveKey,
    source?: string,
    sourceTs?: string,
    vdig?: { readonly id: string; readonly prev: EncryptedEnvelope | null },
  ): Promise<EncryptedEnvelope> {
    const id = ref.id
    // Debug-plaintext: write user-collection records with their fields inlined
    // beside the envelope metadata so native store tools read them directly.
    // Internal (`_`-prefixed) collections keep the classic shape — some store
    // `_`-prefixed fields that the inline layout would collide with.
    if (!this.ctx.storeCiphertext && this.ctx.debugPlaintext && !this.ctx.name.startsWith('_')) {
      return this.buildDebugEnvelope(id, record, version, source, sourceTs)
    }

    // ── C-A / R10 config-drift guard (superset) ────────────────────────
    // A handle may write a classified collection only if its DECLARED
    // digest-only set is a SUPERSET of the collection's stored/marked
    // classified set. Any classified field this handle does NOT declare is a
    // field it cannot maintain: the `_vdig` loop below iterates only declared
    // fields, so an undeclared classified field is neither stripped nor tagged —
    // its value would be serialized into `_data` as DEK-recoverable plaintext
    // (the C-A leak), or its stored tag silently dropped. Fail loud.
    //
    // This subsumes the old naive-only guard (a fully-naive handle has an empty
    // declared set, so ANY stored classified field violates the superset) AND
    // closes the partial-handle door (declares Y, not X, over a record carrying
    // `_vdig[X]`/`_bidx[X]`): the narrow `vdigFields === null || size === 0`
    // gate skipped that entire case. The stored/marked set is the union of:
    //   1. the persisted `x-classified` marker's declared digest-only set
    //      (cross-session, prev-free — the only signal a fully-naive create has);
    //   2. the keys the target `prev` already carries in `_vdig`/`_bidx` (the
    //      overwrite arm; a classified-declaring handle DOES pass `prev`).
    // Only encrypted collections can be classified, so plaintext collections skip.
    if (this.ctx.storeCiphertext) {
      const declared = this.ctx.vdigFields
      const storedClassified = new Set<string>()
      if (vdig?.prev?._vdig) for (const k of Object.keys(vdig.prev._vdig)) storedClassified.add(k)
      if (vdig?.prev?._bidx) for (const k of Object.keys(vdig.prev._bidx)) storedClassified.add(k)
      if (this.ctx.classifiedMarkerDigestOnly !== undefined) {
        for (const k of await this.ctx.classifiedMarkerDigestOnly()) storedClassified.add(k)
      }
      let undeclared: string | undefined
      for (const field of storedClassified) {
        if (declared === null || !declared.has(field)) { undeclared = field; break }
      }
      if (undeclared !== undefined) {
        throw new ClassifiedConfigError(
          this.ctx.name,
          `this collection has classified digest-only field "${undeclared}" but this handle does not declare it — ` +
          'refusing to write (would drop its tag or serialize the secret as plaintext)',
        )
      }
    }

    // Structural group-encryption: peel declared sensitive fields out
    // of the record BEFORE building `_data`, sealing each into its own
    // `_sealed[field]` slot under a per-field key. Default-off — with no
    // sensitive fields the open record is unchanged and no `_sealed` is
    // emitted, so the envelope stays byte-identical to legacy output.
    // A collection whose via pipeline declares at-rest hooks (#629 Task 3)
    // seals through THOSE instead — the inline `sensitiveFields` path and
    // the hook path are mutually exclusive per collection, gated on
    // `hasAtRestHooks` (the inline path now serves only the plain
    // `sensitive: [...]` collection option; since #629, `classifiedFields`-
    // declared fields seal through their own via-binding hook, and since
    // #638 so does any field the taint graph seals — `via/classified/
    // binding.ts` and `kernel/via/taint-binding.ts`, respectively). The
    // zero-via fast path (no `via`, or a pipeline with no at-rest hooks,
    // e.g. money-only) always takes the `else if` branch, unchanged.
    let openRecord = record
    let sealed: Record<string, string> | undefined
    if (this.ctx.storeCiphertext && this.ctx.via?.hasAtRestHooks) {
      // Was `id === undefined`, which #1051 made UNREACHABLE — `ref.id` is a
      // required `string` now, so the compiler asks the question instead. The
      // backstop is retargeted rather than deleted: an EMPTY id still gets
      // through, and it is the realistic hazard, not a hypothetical one. The
      // first draft of this very migration wrote `id ?? ''` to satisfy a
      // trailing-optional signature. Once identity is bound into the AEAD every
      // record written with `''` binds to the SAME identity and they become
      // mutually interchangeable — the failure would be silent at write time
      // and unrecoverable later.
      if (id === '') {
        throw new Error(
          `RecordCodec.encryptRecord: collection "${this.ctx.name}" has via at-rest hooks but this write ` +
          'path supplied an empty record id (needed to scope the sealed-slot capability) — caller bug.',
        )
      }
      const src = record as unknown as Record<string, unknown>
      const result = await this.ctx.via.encodeAtRest(src, this.viaCryptoCtx(id, cek))
      openRecord = result.record as unknown as T
      if (result.sealed !== undefined) {
        sealed = {}
        for (const [field, ref] of Object.entries(result.sealed)) sealed[field] = `${ref.iv}:${ref.data}`
      }
    } else if (this.ctx.storeCiphertext && this.ctx.sensitiveFields.size > 0) {
      const src = record as unknown as Record<string, unknown>
      const result = await sealFields(src, this.ctx.sensitiveFields, this.sealKeyMaterial(cek))
      if (result.sealed !== undefined) {
        sealed = result.sealed
        openRecord = result.openRecord as unknown as T
      }
    }

    // ── Digest-only classified fields (stage 2, C6) ────────────────────
    // Per field, exactly one of: carry-forward (absent) / rotate (string) /
    // clear (null) / loud error (anything else). Runs on a CLONE so the
    // caller's record object is never mutated.
    let vdigOut: Record<string, string> | undefined
    let bidxOutMap: Record<string, string> | undefined
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
      // _bidx (blind-index equality tags) rides the SAME iteration as _vdig,
      // so the structural invariant _bidx[field] ⇒ _vdig[field] holds by
      // construction: a tag is only ever written where the _vdig slot is
      // written/carried. DEK is fetched lazily — only an equatable rotate needs it.
      const bidxOut: Record<string, string> = {}
      let bidxDek: EnclaveKey | undefined
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
          // I-3 monotonic carry: whenever the _vdig slot is carried, ALSO copy
          // prev._bidx[field] verbatim — regardless of THIS handle's equatable
          // knob. An unrelated put by a handle with equatable removed must not
          // drop another handle's tag (anti-flip-flop). If prev has no tag,
          // there is nothing to mint from (no plaintext) → stays uncovered.
          if (prevBlob !== undefined) {
            out[field] = prevBlob
            const prevTag = vdig.prev?._bidx?.[field]
            if (prevTag !== undefined) bidxOut[field] = prevTag
          }
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
        // _bidx branch 2: if this handle is equatable, mint a fresh tag through
        // the SAME normalization pipeline mintVdigSlot uses (normalizeForVerify)
        // — the tag provably equals computeBidxTarget for this value. If the
        // knob is OFF, emit nothing: the stale prev tag points at the now-
        // superseded value (carrying it would be wrong) and minting is disallowed
        // (knob off) → the tag is dropped. Confirm-by-verify keeps this sound.
        if (policy.equatable === true) {
          if (bidxDek === undefined) bidxDek = await this.ctx.getDEK()
          const normalized = normalizeForVerify(policy.normalize, value)
          bidxOut[field] = await mintBidxTag(normalized, bidxDek, this.ctx.name, field)
        }
        delete open[field] // strip from _data — digest-only never persists plaintext
      }
      openRecord = open as unknown as T
      if (Object.keys(out).length > 0) vdigOut = out
      if (Object.keys(bidxOut).length > 0) bidxOutMap = bidxOut
    }

    const base = await this.encryptJsonString(ref, JSON.stringify(openRecord), version, cek, source, sourceTs)
    const withSealed = sealed ? { ...base, _sealed: sealed } : base
    const withVdig = vdigOut ? { ...withSealed, _vdig: vdigOut } : withSealed
    const withBidx = bidxOutMap ? { ...withVdig, _bidx: bidxOutMap } : withVdig
    if (!this.ctx.deterministicFields || !this.ctx.storeCiphertext) return withBidx

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
    if (Object.keys(det).length === 0) return withBidx
    return { ...withBidx, _det: det }
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
  /**
   * `ref` must be the SAME identity the writer sealed against — which is the
   * storage address, not necessarily this codec's own collection. Search's
   * vector sidecar lives in `_vec`, its lexical index in `_ft`; passing
   * `this.ctx.name` for those would recompute the wrong AAD and fail to open a
   * perfectly good record (#1041).
   */
  async decryptJsonString(ref: RecordRef, envelope: EncryptedEnvelope): Promise<string | null> {
    const id = ref.id
    // RISK #1 (forget cascade): a shred tombstone carries `_data: ''` and no
    // `_cek`. Decrypting it would call `decrypt('', '', dek)` → AES-GCM
    // OperationError → TamperedError. Return null so every read callsite
    // treats it as "absent / skip", matching how get()/list already drop
    // tombstones. Legacy plaintext collections (`!this.storeCiphertext`) legitimately
    // have empty `_iv`/`_data`, so `isTombstone` is false for them — preserved.
    if (isTombstone(envelope, this.ctx.storeCiphertext) || isDeleteMarker(envelope)) return null
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
      // #598: a real record never serializes to '' (JSON.stringify's floor is
      // '{}'), so an empty `_data` here is the sync engine's shape-only
      // tombstone (`isTombstoneShape` in team/sync.ts) landing on an
      // unencrypted collection, where the encryption-gated `isTombstone()`
      // check above doesn't fire. Treat it the same as an encrypted
      // tombstone: null, not a `JSON.parse('')` crash.
      return envelope._data === '' ? null : envelope._data
    }
    const aad = recordAadFor(ref, envelope)
    const cek = await this.resolveEnvelopeCek(envelope, id)
    if (cek !== undefined) return decrypt(envelope._iv, envelope._data, cek, aad)
    const dek = await this.ctx.getDEK()
    return decrypt(envelope._iv, envelope._data, dek, aad)
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
    return unsealOneField(field, blob, this.sealKeyMaterial(cek))
  }

  /**
   * Build the `ViaCryptoCtx` for forget()'s per-ref via-erase fold (#629
   * Task 10) — resolves the live envelope's CEK exactly like
   * `decryptRecord` does, then delegates to the same capability factory
   * `encodeAtRest`/`decodeAtRest` use.
   */
  async eraseCryptoCtx(id: string, live: EncryptedEnvelope): Promise<ViaCryptoCtx> {
    return this.viaCryptoCtx(id, await this.resolveEnvelopeCek(live, id))
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
  ): Promise<{ readonly slots: readonly SealedShredSlot[] }> {
    const slots: SealedShredSlot[] = []
    // Verify-digest slots are CEK-only by construction (I3): dropping `_cek`
    // makes every `_vdig[field]` permanently undecryptable — shreddable
    // unconditionally, no vdig-dekResidue class (spec §2 forget()). Same
    // honesty caveats as #306 D5 for synced/backup copies of the ciphertext.
    // A `_vdig` field ALSO carrying a `_bidx` tag is the third category: the
    // tombstone drops it from the live store, but a pre-forget backup retains
    // the blind-index tag under the surviving collection DEK — live-shreddable
    // yet dekResidue-in-backups. `_bidx[field] ⇒ _vdig[field]` (I4), so we
    // decide per vdig field and emit exactly one slot each (count-preserving).
    if (live._vdig !== undefined && live._cek !== undefined) {
      for (const field of Object.keys(live._vdig)) {
        slots.push({
          field,
          class: live._bidx?.[field] !== undefined
            ? 'live-shreddable+dekResidue-in-backups'
            : 'shreddable',
        })
      }
    }
    const sealed = live._sealed
    if (sealed === undefined) return { slots }
    const cek = await this.resolveEnvelopeCek(live)
    for (const [field, blob] of Object.entries(sealed)) {
      if (cek === undefined) { slots.push({ field, class: 'dekResidue' }); continue }
      const { iv, data } = parseSealedSlot(blob)
      try {
        await decrypt(iv, data, await deriveSealedFieldKeyFromCek(cek, this.ctx.name, field))
        slots.push({ field, class: 'shreddable' })
      } catch {
        slots.push({ field, class: 'dekResidue' })
      }
    }
    return { slots }
  }

  /**
   * Build a non-leaking {@link Sealed} handle over a sealed field's ciphertext.
   * The handle captures only the ciphertext `blob` and a closure to
   * {@link unsealField}; the plaintext is never stored on it — so the handle
   * may sit in the working-set cache (or be logged/serialised) without
   * exposing the value, which decrypts only on `reveal()`.
   */
  makeSealedHandle(field: string, blob: string, cek?: EnclaveKey): SealedHandle<unknown> {
    return makeHandleProducer(this.sealKeyMaterial(cek))(field, blob)
  }

  /**
   * Replace every field the just-written envelope actually sealed with a
   * {@link Sealed} handle, leaving every other field as its plaintext value.
   * Used to populate the cache on the write path without ever materialising
   * sealed plaintext into it. Returns `record` untouched when nothing was
   * sealed. Keys off `envelope._sealed` itself (#642 fix) — NOT
   * `this.ctx.sensitiveFields`, which only names the inline `sensitive:[...]`/
   * classified-recoverable field set: a collection whose sealing comes
   * entirely from the `taint` via-binding (a derivation/MV output or rollup
   * target folded sealed from a classified SOURCE collection, #642) declares
   * no local `sensitiveFields` at all, so that stale gate skipped this
   * conversion and left a just-written taint-sealed field as cached
   * plaintext — read back correctly ONLY after a cold cache miss (`get()`'s
   * own `decodeAtRest` call, unaffected by this gate) forced a fresh decrypt.
   */
  async toCacheRecord(record: T, envelope: EncryptedEnvelope, id?: string): Promise<T> {
    const sealed = envelope._sealed
    if (sealed === undefined || !this.ctx.storeCiphertext) {
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
   * Apply `_sealed`-slot post-processing to an ALREADY-DECRYPTED `record`:
   * restore each `_sealed[field]` blob inline (`sealedAsHandles` falsy) or
   * as an opaque {@link Sealed} handle (`sealedAsHandles: true`), routing
   * through a via pipeline's `decodeAtRest` hook when one is declared.
   * Extracted byte-parity from `decryptRecord`'s inline block (#635) so a
   * caller that resolves its OWN per-record CEK under a DIFFERENT DEK than
   * this codec's `this.ctx.getDEK()` — namely the tier>0 `getAtTier` leg in
   * `with-audit/tiers/index.ts`, whose `_cek` is wrapped under the TIER DEK,
   * not the collection DEK `decryptRecord`/`resolveEnvelopeCek` always
   * unwrap under — can still get correct sealed-slot handling without
   * routing its whole read through `decryptRecord` (which would resolve the
   * wrong DEK for it).
   *
   * Zero-knowledge: takes only the already-resolved per-record `cek` (or
   * `undefined` for a legacy/no-CEK record) — the same shape `makeSealedHandle`
   * already takes above. Never the keyring, never a raw DEK: the legacy
   * fallback key stays fully internal to `sealKeyMaterial`/`viaCryptoCtx`,
   * which close over THIS codec's own `getDEK` (permanently bound to
   * `this.ctx.name`'s tier-0 DEK at construction) — so even when called from
   * a tier>0 context, the legacy-fallback key resolution is correct: sealed
   * fields are always sealed under the CEK or the collection's tier-0 DEK,
   * never a tier DEK (tier writes don't seal fields; `_sealed` reaches a
   * tiered envelope only via a tier-0 write later elevated).
   */
  async applySealedSlots(
    record: T,
    sealed: Record<string, string>,
    cek: EnclaveKey | undefined,
    opts: { id?: string; sealedAsHandles?: boolean } = {},
  ): Promise<T> {
    if (this.ctx.via?.hasAtRestHooks) {
      // Retargeted from `=== undefined`, which #1041 made unreachable on the
      // read path too: `decryptRecord` now takes a required identity, so the
      // compiler asks that question. An EMPTY id can still get through, and it
      // would scope every record's sealed slots to the same capability.
      if (opts.id === undefined || opts.id === '') {
        throw new Error(
          `RecordCodec.decryptRecord: collection "${this.ctx.name}" has via at-rest hooks but this read ` +
          'path supplied no record id (needed to scope the sealed-slot capability) — caller bug.',
        )
      }
      const sealedRefs: Record<string, SealedSlotRef> = {}
      for (const [field, blob] of Object.entries(sealed)) {
        const { iv, data } = parseSealedSlot(blob)
        sealedRefs[field] = { iv, data }
      }
      return await this.ctx.via.decodeAtRest(
        record as unknown as Record<string, unknown>,
        sealedRefs,
        this.viaCryptoCtx(opts.id, cek),
        { asHandles: opts.sealedAsHandles === true },
      ) as unknown as T
    }
    return await unsealFields(
      record as unknown as Record<string, unknown>,
      sealed,
      this.sealKeyMaterial(cek),
      { asHandles: opts.sealedAsHandles === true },
    ) as unknown as T
  }

  /**
   * Decrypt an envelope under an EXPLICIT `dek` instead of this codec's own
   * `ctx.getDEK()` / cekCache resolution — for a from-tier>0 pre-move decode
   * (`with-audit/tiers/index.ts`'s `putAtTier`/`elevate`/`demote` sites,
   * #722 whole-branch review). Mirrors the manual unwrap-then-decrypt
   * `getAtTier`'s own tier>0 leg performs there (same primitives, same
   * `applySealedSlots` extraction point #635 built for exactly this caller).
   *
   * `decryptRecord` is tier-UNAWARE: `resolveEnvelopeCek` reads the cekCache
   * or falls back to `ctx.getDEK()` — this codec's DEFAULT (tier-0/
   * collection) DEK — never the envelope's OWN tier. That only happens to
   * decrypt a from-tier>0 envelope correctly when some other call in the
   * SAME op already primed the cekCache with this record's CEK (true for an
   * ordinary put()-then-elevate(0→1); NOT true for a `putAtTier`-origin
   * envelope, whose body is encrypted directly under its tier DEK with no
   * `_cek` ever minted, or a non-`perRecordKeys` collection, which has no
   * `_cek` at all) — those throw `TamperedError`. Decrypting under the
   * caller-resolved `dek` is correct regardless of cache state or
   * `perRecordKeys`.
   *
   * No CRDT resolution, no schema validation — same scope as `getAtTier`'s
   * tier>0 branch (the established precedent for a tier-aware read), which
   * skips both for the same reason: a tier>0 read is an internal/derived-
   * output-recompute path, not the public per-record read surface schema
   * validation guards.
   */
  async decryptRecordAtDek(ref: RecordRef, envelope: EncryptedEnvelope, dek: EnclaveKey): Promise<T | null> {
    const id = ref.id
    if (isTombstone(envelope, this.ctx.storeCiphertext) || isDeleteMarker(envelope)) return null
    let plaintext: string
    let cek: EnclaveKey | undefined
    const aad = recordAadFor(ref, envelope)
    if (envelope._cek !== undefined) {
      cek = await unwrapCek(envelope._cek, dek)
      plaintext = await decrypt(envelope._iv, envelope._data, cek, aad)
    } else {
      plaintext = await decrypt(envelope._iv, envelope._data, dek, aad)
    }
    let record = JSON.parse(plaintext) as T
    if (envelope._sealed !== undefined && this.ctx.storeCiphertext) {
      record = await this.applySealedSlots(record, envelope._sealed, cek, { ...(id !== undefined ? { id } : {}), sealedAsHandles: true })
    }
    return record
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
    ref: RecordRef,
    envelope: EncryptedEnvelope,
    opts: { skipValidation?: boolean; sealedAsHandles?: boolean } = {},
  ): Promise<T | null> {
    const json = await this.decryptJsonString(ref, envelope)
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
    // plaintext is never materialised into the working-set cache. A
    // collection whose via pipeline declares at-rest hooks (#629 Task 3)
    // decodes through THOSE instead of the inline dual-read below — the
    // zero-via fast path (no `via`, or a pipeline with no at-rest hooks)
    // always takes the `else` branch, unchanged.
    if (envelope._sealed !== undefined && this.ctx.storeCiphertext) {
      const sealedCek = await this.resolveEnvelopeCek(envelope, ref.id)
      record = await this.applySealedSlots(record, envelope._sealed, sealedCek, {
        id: ref.id,
        ...(opts.sealedAsHandles !== undefined ? { sealedAsHandles: opts.sealedAsHandles } : {}),
      })
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
