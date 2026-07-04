/**
 * Classified fields — behavioral sensitive-field descriptors (stage 1).
 * Design: docs/superpowers/specs/2026-07-04-classified-fields-design.md
 * Law: open on write, declarative on read — read-side behavior is this
 * closed vocabulary; there are no read-side callbacks.
 * @module
 */

export type ClassifiedStorage = 'recoverable' | 'never' | 'digest-only'

export type ClassifiedList =
  | { readonly kind: 'omit' }
  | { readonly kind: 'mask'; readonly pattern: string }
  | { readonly kind: 'rider'; readonly rider: string }

export type ClassifiedRider = (value: unknown) => unknown

export interface ClassifiedFieldSpec {
  readonly _noydbClassified: true
  readonly preset: string
  readonly storage: ClassifiedStorage
  readonly list: ClassifiedList
  readonly sensitivity: 'pii' | 'secret'
  /** Write-time safe projections; companion field name is `<field>_<rider>`. */
  readonly riders?: Record<string, ClassifiedRider>
  /** Write-time validator: error message, or null when valid. */
  readonly validate?: (value: unknown) => string | null
  /** Digest-only verify policy (stage 2). Mode both sides normalize under. */
  readonly verifyNormalize?: 'password' | 'secret-answer'
  /** Decorate ok:true verdicts with mustRotate after this many days (I1). */
  readonly rotateDays?: number
  /** Refuse reuse of the last N values on rotate (cap 8, spec Q4). */
  readonly notLastN?: number
  /** Member of the collection's matchGroup (secretAnswer preset). */
  readonly verifyGroupMember?: true
}

export interface ClassifiedGroup {
  readonly _noydbClassifiedGroup: true
  readonly preset: string
  /** member record-field name -> spec (differential per-member policy). */
  readonly members: Record<string, ClassifiedFieldSpec>
}

export type ClassifiedEntry = ClassifiedFieldSpec | ClassifiedGroup

export function isClassifiedFieldSpec(x: unknown): x is ClassifiedFieldSpec {
  return typeof x === 'object' && x !== null
    && (x as { _noydbClassified?: unknown })._noydbClassified === true
}

export function isClassifiedGroup(x: unknown): x is ClassifiedGroup {
  return typeof x === 'object' && x !== null
    && (x as { _noydbClassifiedGroup?: unknown })._noydbClassifiedGroup === true
}
