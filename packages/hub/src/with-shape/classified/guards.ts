/**
 * Refusal matrix R1-R5 (spec) — ONE guard, run at BOTH doors:
 * `collection()` config resolution AND `_applyClassifiedFields` (the reconcile
 * seam), because crdt/conflictPolicy/perRecordKeys are construction-only
 * while classifiedFields can attach later (C5's lesson). @module
 */
import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedConfigError } from '../../kernel/errors.js'

export interface ClassifiedGuardCtx {
  readonly perRecordKeys: boolean
  readonly crdt: boolean
  readonly hasConflictPolicy: boolean
  /** False on plaintext (`encrypt: false`) collections — no vdig/seal path exists. */
  readonly storeCiphertext: boolean
  readonly deterministicFields: ReadonlySet<string> | null
  readonly indexedFields: ReadonlySet<string>
  readonly textIndexFields: ReadonlySet<string>
  readonly vectorSourceFields: ReadonlySet<string>
  readonly subjectKeyField: string | undefined
  readonly bareSensitiveFields: ReadonlySet<string>
  /** Collection-level gate for the `equatable` knob (R8 double door). */
  readonly acknowledgeEquatableRisk: boolean
}

export function guardClassifiedCompat(
  collection: string,
  byField: Record<string, ClassifiedFieldSpec>,
  ctx: ClassifiedGuardCtx,
): void {
  const digestOnly = Object.entries(byField)
    .filter(([, s]) => s.storage === 'digest-only')
  const protectedForms = Object.values(byField)
    .filter((s) => s.storage === 'digest-only' || s.storage === 'recoverable')

  // R2 — merge resolvers bypass the write pipeline entirely (C5): a merge
  // could carry stale/foreign _vdig or resurrect plaintext (the CRDT put
  // branch persists via encryptJsonString with no vdig backstop). Fail-loud.
  if (protectedForms.length > 0 && (ctx.crdt || ctx.hasConflictPolicy)) {
    throw new ClassifiedConfigError(collection,
      'digest-only/recoverable classified fields cannot combine with a crdt mode or a ' +
      'conflictPolicy resolver — merge paths bypass write enforcement (R2)')
  }
  // R7 — `equatable` is a digest-only knob: it drives the `_bidx` blind-index
  // slot, which only exists on the digest-only write path. A recoverable/never
  // field carrying it would silently no-op (recoverable equality is `_det`'s
  // job). Refuse rather than accept-and-ignore. Checked over ALL specs, before
  // the digest-only early-return below, precisely to catch the non-digest case.
  for (const [f, spec] of Object.entries(byField)) {
    if (spec.equatable === true && spec.storage !== 'digest-only') {
      throw new ClassifiedConfigError(collection,
        `field "${f}" declares equatable but storage is '${spec.storage}' — equatable is a ` +
        `digest-only knob; recoverable equality is _det's job (R7)`)
    }
  }

  // R8 — the equatable double door (mirrors deterministicFields ×
  // acknowledgeDeterministicRisk): any field opting into `equatable` requires
  // the collection to acknowledge the partition-leak risk. One-directional —
  // `acknowledgeEquatableRisk: true` with ZERO equatable members is a silent
  // no-op (never throws here), so the ack can sit on a collection config
  // ahead of the field landing.
  const hasEquatable = Object.values(byField).some((s) => s.equatable === true)
  if (hasEquatable && ctx.acknowledgeEquatableRisk !== true) {
    throw new ClassifiedConfigError(collection,
      `classified equatable fields require \`acknowledgeEquatableRisk: true\` — equal values ` +
      `produce equal store-visible index tags (a partition leak a DEK holder can offline-` +
      `dictionary at the PBKDF2 floor); the door is the real control for low-entropy fields (R8)`)
  }

  if (digestOnly.length === 0) return

  // Digest-only on a plaintext collection: the codec's vdig block is gated on
  // storeCiphertext, so the secret would persist as raw plaintext. Refuse.
  if (!ctx.storeCiphertext) {
    throw new ClassifiedConfigError(collection,
      `storage:'digest-only' requires an encrypted collection — with encrypt: false the ` +
      `write path skips the digest slot entirely and the secret would persist as raw plaintext`)
  }
  // R1 — vdig slot keys are CEK-only (I3); without perRecordKeys a digest
  // would survive forget() in backups as offline-crackable material.
  if (!ctx.perRecordKeys) {
    throw new ClassifiedConfigError(collection,
      `storage:'digest-only' requires perRecordKeys: true — vdig keys derive from the ` +
      `per-record CEK so forget() shreds them (R1)`)
  }
  for (const [f, spec] of digestOnly) {
    // notLastN cap: presets clamp this at construction, but a raw spec object
    // bypasses the preset — enforce the same 0..8 cap in the policy projection.
    const n = spec.notLastN ?? 0
    if (!Number.isInteger(n) || n < 0 || n > 8) {
      throw new ClassifiedConfigError(collection,
        `digest-only field "${f}" declares notLastN ${n} — must be an integer 0..8 ` +
        `(write cost is n × 600K PBKDF2; ring blast radius is documented)`)
    }
    if (ctx.bareSensitiveFields.has(f)) {
      // R5 — the sealed block runs before the vdig block in the codec, so the
      // overlap would seal the value recoverably (silent downgrade + I4
      // double-slot). Storage forms are mutually exclusive per field.
      throw new ClassifiedConfigError(collection,
        `field "${f}" is digest-only AND listed in sensitive[] — storage forms are mutually exclusive per field (R5)`)
    }
    if (ctx.deterministicFields?.has(f)) {
      throw new ClassifiedConfigError(collection,
        `digest-only field "${f}" cannot be deterministic — equality-correlatable ciphertext defeats per-write salts (R3)`)
    }
    if (ctx.indexedFields.has(f) || ctx.textIndexFields.has(f)
      || ctx.vectorSourceFields.has(f) || ctx.subjectKeyField === f) {
      throw new ClassifiedConfigError(collection,
        `digest-only field "${f}" cannot be indexed, text-indexed, embedded, or a forget-subject key (R4)`)
    }
  }
}
