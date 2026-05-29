export type Normalizer = 'trim' | 'lower' | 'upper' | 'alnum-upper' | 'digits' | 'cents' | 'iso-date'

export interface AttestationFieldSpec {
  readonly path: string
  readonly normalize: Normalizer
}
export interface AttestationFieldSchema {
  readonly fields: readonly AttestationFieldSpec[]
}
