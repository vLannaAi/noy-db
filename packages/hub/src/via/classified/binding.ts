/**
 * The classified `NoydbVia` (#629 Task 5, LIVE since Task 6) — wires
 * classified-fields declaration/write-enforcement/at-rest sealing/erasure
 * into the kernel's generic Via port. Mirrors `via/money/binding.ts`'s
 * inline declaration-time validation and `via/i18n/binding.ts`'s
 * `linkXVia` static-link pattern — except the link itself is EAGER
 * (`port/with/classified-strategy.ts` calls `linkClassifiedVia()` at module
 * load, not lazily from a `classified.*()` preset call): several fixtures
 * build a raw `ClassifiedFieldSpec` literal without ever calling a preset,
 * and the binder must be installed before `compileVias` needs it
 * regardless.
 *
 * `compileVias` (`kernel/collection-config.ts`) compiles this binding
 * in whenever a collection declares `classifiedFields` — money then i18n
 * then classified, order pinned. `kernel/collection.ts`'s `_putInternal`
 * runs `enforceClassifiedWrite`'s effect via the pipeline's `enforceWrite`
 * phase; the codec's `encodeAtRest`/`decodeAtRest` hooks (Task 3's boundary)
 * replace the inline `sensitiveFields` seal path for any collection this
 * binding is compiled into.
 *
 * `declare` — `classifiedVia(cfg)` runs `resolveClassifiedFields` +
 * `guardClassifiedCompat` at CONSTRUCTION time (the same #553 pattern
 * `moneyVia`'s `validateMoneyFieldPaths(moneyFields)` call uses) —
 * mirrors today's "door 1" (`collection-config.ts`'s
 * `resolveCollectionConfig`). Both may throw `ClassifiedConfigError`.
 */
import type { NoydbVia, ViaWriteCtx, ViaCryptoCtx, SealedSlotRef, ViaEraseCtx, ViaEraseReport } from '../../kernel/via/index.js'
import { installViaBinder } from '../../kernel/via/index.js'
import { SealedHandle } from '../../kernel/types.js'
import { resolveClassifiedFields, type ClassifiedEntry } from './resolve.js'
import { guardClassifiedCompat, type ClassifiedGuardCtx } from './guards.js'
import { enforceClassifiedWrite } from './write.js'
import type { ClassifiedFieldSpec } from './descriptor.js'

/**
 * One classified per-slot shred/residue verdict — mirrors
 * `RecordCodec.SealedShredSlot` (`kernel/enclave/record-keys/record-codec.ts`)
 * byte-for-byte. Duplicated here (not imported) so this binding never
 * reaches into `kernel/enclave/` (`via-enclave-isolation`, #629) — the
 * closure that PRODUCES real values of this shape is codec-owned and
 * injected via {@link ClassifiedViaConfig.classifySealedShred}.
 */
export interface ClassifiedShredSlot {
  readonly field: string
  readonly class: 'shreddable' | 'dekResidue' | 'live-shreddable+dekResidue-in-backups'
}

/**
 * Config a classified collection's declarations resolve to — the binding's
 * construction input. `entries`/`guardCtx` are the raw "door 1" inputs
 * (`resolveClassifiedFields`/`guardClassifiedCompat`'s own parameters);
 * `classifySealedShred`/`purgeSealedCekEnvelopes` are OPTIONAL codec/vault-
 * provided closures for the `erase` hook — undefined in this dormant task
 * (no caller wires them yet), wired for real in #629 Task 10 ("posture
 * enforcement — forget + erase hooks live").
 */
export interface ClassifiedViaConfig {
  readonly entries: Record<string, ClassifiedEntry>
  readonly collectionName: string
  readonly guardCtx: ClassifiedGuardCtx
  /**
   * Codec-provided closure mirroring `RecordCodec.classifySealedShred` —
   * classifies a live envelope's `_sealed` slots for crypto-shred
   * completeness (see that method's doc comment for the shreddable/
   * dekResidue/both-class semantics). `live` is `ViaEraseCtx.live`'s opaque
   * envelope, passed straight through. NOT `readonly` (#629 Task 10):
   * `compileVias` builds this cfg before the owning `Collection`'s
   * `RecordCodec` exists, so `Collection`'s constructor mutates this field
   * in place once `this.codec` is available — the closure `eraseClassified`
   * reads is looked up at CALL time, not at binding-construction time, so
   * the late assignment is picked up correctly.
   */
  classifySealedShred?: (live: unknown) => Promise<{ readonly slots: readonly ClassifiedShredSlot[] }>
  /**
   * Vault-provided closure that purges every `_sealed_cek/<collection>/<id>/*`
   * host-delivery envelope for one record (mirrors `rotateRecordCek`'s own
   * prefix-delete) and returns the count purged. Deliberately left UNWIRED
   * by `compileVias` (#629 Task 10) — `forget-sealed-erasure.test.ts`
   * proves this purge is UNCONDITIONAL on `sealRecordToHost` usage alone,
   * independent of whether `classifiedFields` is declared (a bare
   * `sensitive: [...]` collection exercises it with no classified binding
   * at all) — vault.ts keeps owning it directly so that case stays correct.
   */
  readonly purgeSealedCekEnvelopes?: (id: string) => Promise<number>
}

/** Fields declared `storage: 'recoverable'` (digest-only stays codec-inline; `'never'` is rejected by `enforceWrite` before either hook runs). */
function recoverableFields(byField: Record<string, ClassifiedFieldSpec>): string[] {
  return Object.entries(byField).filter(([, spec]) => spec.storage === 'recoverable').map(([field]) => field)
}

/**
 * The full set this binding's `encodeAtRest`/`decodeAtRest` seal: declared
 * recoverable classified fields UNION bare `sensitive[]` fields — mirrors
 * `collection-config.ts`'s pre-cutover "recoverable classified fields are
 * unioned into sensitiveFields... zero new crypto code" semantics. Once this
 * binding is compiled into a collection's pipeline, `hasAtRestHooks` is true
 * and the codec's inline `sensitiveFields` seal path (record-codec.ts) is
 * DEAD for that collection — mutually exclusive with the hook path (#629
 * Task 3) — so bare `sensitive[]` fields MUST seal through here too, or
 * they'd silently stop being sealed at all (#629 Task 6 reconciliation).
 * `guardCtx.bareSensitiveFields` is the exact same `Set` the collection's
 * refusal-matrix guard already carries (`ClassifiedGuardCtx`).
 */
function sealFieldNames(byField: Record<string, ClassifiedFieldSpec>, guardCtx: ClassifiedGuardCtx): string[] {
  return [...recoverableFields(byField), ...guardCtx.bareSensitiveFields]
}

/**
 * Seal every named field present with a defined value into its own sealed
 * slot via `crypto.sealedSlots`, peeling it out of the record.
 */
async function encodeClassifiedAtRest(
  record: Record<string, unknown>,
  crypto: ViaCryptoCtx,
  fields: readonly string[],
): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }> {
  let open = record
  let sealed: Record<string, SealedSlotRef> | undefined
  for (const field of fields) {
    if (!(field in record)) continue
    const value = record[field]
    if (value === undefined) continue
    const ref = await crypto.sealedSlots.seal(field, value)
    if (open === record) open = { ...record }
    delete open[field]
    sealed ??= {}
    sealed[field] = ref
  }
  return sealed ? { record: open, sealed } : { record }
}

/**
 * Restore every named field's sealed slot back onto the record: an opaque
 * `SealedHandle` under `asHandles` (never materialises plaintext into the
 * cache — `SealedHandle.toJSON()` returns `'[sealed]'`, the export-redaction
 * guarantee `reveal()` alone can lift), the plaintext value otherwise.
 */
async function decodeClassifiedAtRest(
  record: Record<string, unknown>,
  sealed: Record<string, SealedSlotRef>,
  crypto: ViaCryptoCtx,
  opts: { asHandles: boolean },
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  let out = record
  for (const field of fields) {
    const ref = sealed[field]
    if (ref === undefined) continue
    if (out === record) out = { ...record }
    out[field] = opts.asHandles
      ? new SealedHandle(() => crypto.sealedSlots.unseal(field, ref))
      : await crypto.sealedSlots.unseal(field, ref)
  }
  return out
}

/**
 * `forget()`'s per-ref erasure participation: classify the live envelope's
 * sealed slots (via the codec-provided closure) and mark each shreddable
 * one deleted on this call's sealed-slots capability, then purge the
 * record's sealed-CEK host-delivery envelopes (via the vault-provided
 * closure). Both closures are optional — undefined (this dormant task's
 * only caller, its own unit tests) reports a zero-shredded, zero-residue
 * no-op rather than throwing.
 */
async function eraseClassified(
  ctx: ViaEraseCtx,
  cfg: ClassifiedViaConfig,
): Promise<ViaEraseReport> {
  let shredded = 0
  const residue: unknown[] = []

  if (cfg.classifySealedShred) {
    const { slots } = await cfg.classifySealedShred(ctx.live)
    for (const slot of slots) {
      if (slot.class === 'shreddable' || slot.class === 'live-shreddable+dekResidue-in-backups') {
        shredded += 1
        await ctx.crypto.sealedSlots.delete(slot.field)
      }
      if (slot.class === 'dekResidue' || slot.class === 'live-shreddable+dekResidue-in-backups') {
        residue.push({ kind: 'classified-sealed-dek-residue', field: slot.field })
      }
    }
  }

  if (cfg.purgeSealedCekEnvelopes) {
    shredded += await cfg.purgeSealedCekEnvelopes(ctx.id)
  }

  return { shredded, residue }
}

function buildClassifiedDescribeFragment(byField: Record<string, ClassifiedFieldSpec>): Record<string, unknown> {
  return {
    classifiedFields: Object.fromEntries(
      Object.entries(byField).map(([field, spec]) => [field, { storage: spec.storage, sensitivity: spec.sensitivity }]),
    ),
  }
}

export function classifiedVia(cfg: ClassifiedViaConfig): NoydbVia {
  // declare — door 1: resolve + guard, exactly like collection-config.ts's
  // resolveCollectionConfig does today. Throws ClassifiedConfigError on any
  // R1-R8 refusal-matrix violation or field-collision.
  const resolved = resolveClassifiedFields(cfg.collectionName, cfg.entries)
  guardClassifiedCompat(cfg.collectionName, resolved.byField, cfg.guardCtx)
  const byField = resolved.byField
  const sealFields = sealFieldNames(byField, cfg.guardCtx)

  return {
    brand: 'classified',
    posture: { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true },
    covers: (field) => field in byField,
    // async (rather than a bare passthrough) so a refusal is always a
    // rejected Promise for direct callers, matching every other async-stack
    // hook's calling convention — `enforceClassifiedWrite` itself stays sync.
    enforceWrite: async (record: Record<string, unknown>, _ctx: ViaWriteCtx) =>
      enforceClassifiedWrite(record, byField, cfg.collectionName),
    encodeAtRest: (record, crypto) => encodeClassifiedAtRest(record, crypto, sealFields),
    decodeAtRest: (record, sealed, crypto, opts) => decodeClassifiedAtRest(record, sealed, crypto, opts, sealFields),
    erase: (ctx) => eraseClassified(ctx, cfg),
    describeFragment: () => buildClassifiedDescribeFragment(byField),
  }
}

export function linkClassifiedVia(): void {
  installViaBinder('classified', (c) => classifiedVia(c as ClassifiedViaConfig))
}
