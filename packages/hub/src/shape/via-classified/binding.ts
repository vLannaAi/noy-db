/**
 * The classified `ViaBinding` (#629 Task 5) — wires classified-fields
 * declaration/write-enforcement/at-rest sealing/erasure into the kernel's
 * generic Via port. Mirrors `shape/via-money/binding.ts`'s inline
 * declaration-time validation and `shape/via-i18n/binding.ts`'s `linkXVia`
 * static-link pattern.
 *
 * DORMANT: `linkClassifiedVia()` is never called anywhere in this task —
 * the kernel still hand-wires `resolveClassifiedFields`/
 * `guardClassifiedCompat`/`enforceClassifiedWrite` directly (temporarily
 * grandfathered in `scripts/check-architecture.mjs`'s `VIA_SHAPE_ALLOWLIST`).
 * #629 Task 6 (kernel cutover) compiles this binding into
 * `compileViaBindings`, retires the grandfather, and deletes the kernel's
 * direct classified imports.
 *
 * `declare` — `classifiedBinding(cfg)` runs `resolveClassifiedFields` +
 * `guardClassifiedCompat` at CONSTRUCTION time (the same #553 pattern
 * `moneyBinding`'s `validateMoneyFieldPaths(moneyFields)` call uses) —
 * mirrors today's "door 1" (`collection-config.ts`'s
 * `resolveCollectionConfig`). Both may throw `ClassifiedConfigError`.
 */
import type { ViaBinding, ViaWriteCtx, ViaCryptoCtx, SealedSlotRef, ViaEraseCtx, ViaEraseReport } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
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
   * envelope, passed straight through.
   */
  readonly classifySealedShred?: (live: unknown) => Promise<{ readonly slots: readonly ClassifiedShredSlot[] }>
  /**
   * Vault-provided closure that purges every `_sealed_cek/<collection>/<id>/*`
   * host-delivery envelope for one record (mirrors `rotateRecordCek`'s own
   * prefix-delete) and returns the count purged.
   */
  readonly purgeSealedCekEnvelopes?: (id: string) => Promise<number>
}

/** Fields declared `storage: 'recoverable'` — the only storage form `encodeAtRest`/`decodeAtRest` touch (digest-only stays codec-inline; `'never'` is rejected by `enforceWrite` before either hook runs). */
function recoverableFields(byField: Record<string, ClassifiedFieldSpec>): string[] {
  return Object.entries(byField).filter(([, spec]) => spec.storage === 'recoverable').map(([field]) => field)
}

/**
 * Seal every declared recoverable field present with a defined value into
 * its own sealed slot via `crypto.sealedSlots`, peeling it out of the
 * record — the same "recoverable classified fields are unioned into
 * sensitiveFields... zero new crypto code" semantics
 * `collection-config.ts:598-605` documents for today's inline path.
 */
async function encodeClassifiedAtRest(
  record: Record<string, unknown>,
  crypto: ViaCryptoCtx,
  byField: Record<string, ClassifiedFieldSpec>,
): Promise<{ record: Record<string, unknown>; sealed?: Record<string, SealedSlotRef> }> {
  let open = record
  let sealed: Record<string, SealedSlotRef> | undefined
  for (const field of recoverableFields(byField)) {
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
 * Restore every declared recoverable field's sealed slot back onto the
 * record: an opaque `SealedHandle` under `asHandles` (never materialises
 * plaintext into the cache — `SealedHandle.toJSON()` returns `'[sealed]'`,
 * the export-redaction guarantee `reveal()` alone can lift), the plaintext
 * value otherwise.
 */
async function decodeClassifiedAtRest(
  record: Record<string, unknown>,
  sealed: Record<string, SealedSlotRef>,
  crypto: ViaCryptoCtx,
  opts: { asHandles: boolean },
  byField: Record<string, ClassifiedFieldSpec>,
): Promise<Record<string, unknown>> {
  let out = record
  for (const field of recoverableFields(byField)) {
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

export function classifiedBinding(cfg: ClassifiedViaConfig): ViaBinding {
  // declare — door 1: resolve + guard, exactly like collection-config.ts's
  // resolveCollectionConfig does today. Throws ClassifiedConfigError on any
  // R1-R8 refusal-matrix violation or field-collision.
  const resolved = resolveClassifiedFields(cfg.collectionName, cfg.entries)
  guardClassifiedCompat(cfg.collectionName, resolved.byField, cfg.guardCtx)
  const byField = resolved.byField

  return {
    brand: 'classified',
    posture: { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true },
    // async (rather than a bare passthrough) so a refusal is always a
    // rejected Promise for direct callers, matching every other async-stack
    // hook's calling convention — `enforceClassifiedWrite` itself stays sync.
    enforceWrite: async (record: Record<string, unknown>, _ctx: ViaWriteCtx) =>
      enforceClassifiedWrite(record, byField, cfg.collectionName),
    encodeAtRest: (record, crypto) => encodeClassifiedAtRest(record, crypto, byField),
    decodeAtRest: (record, sealed, crypto, opts) => decodeClassifiedAtRest(record, sealed, crypto, opts, byField),
    erase: (ctx) => eraseClassified(ctx, cfg),
    describeFragment: () => buildClassifiedDescribeFragment(byField),
  }
}

export function linkClassifiedVia(): void {
  installViaBinder('classified', (c) => classifiedBinding(c as ClassifiedViaConfig))
}
