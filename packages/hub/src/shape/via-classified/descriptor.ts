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
  /**
   * Via port brand marker — lets a `ClassifiedFieldSpec` satisfy the
   * kernel's opaque `ViaDescriptor` (#629 Task 5). Optional (unlike
   * `MoneyDescriptor._viaBrand`/`I18nTextDescriptor._viaBrand`, which are
   * required): every `classified.*()` preset factory stamps it, but the
   * pre-existing test suite's hand-rolled `ClassifiedFieldSpec` fixtures
   * (built without going through a preset) predate this field and would
   * fail to compile if it were mandatory.
   */
  readonly _viaBrand?: 'classified'
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
  /**
   * Opt into a store-visible blind-index (`_bidx`) tag so equal values become
   * queryable/joinable while staying digest-only. Digest-only knob (R7); gated
   * behind the collection's `acknowledgeEquatableRisk` door (R8). Equal values
   * produce equal tags — a partition leak a DEK holder can offline-dictionary
   * at the PBKDF2 floor. Absent/false ⇒ refused-by-default.
   */
  readonly equatable?: true
}

export interface ClassifiedGroup {
  readonly _noydbClassifiedGroup: true
  /** Via port brand marker — see {@link ClassifiedFieldSpec._viaBrand}. */
  readonly _viaBrand?: 'classified'
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
