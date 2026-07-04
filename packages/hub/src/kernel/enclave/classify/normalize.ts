/**
 * Preset normalization for verify candidates AND stored comparands (§4).
 * Both sides of every comparison route through the SAME function so
 * write-time digests and verify-time candidates agree. @module
 */
export type VerifyNormalizeMode = 'password' | 'secret-answer'

export function normalizeForVerify(mode: VerifyNormalizeMode, value: string): string {
  const nfc = value.normalize('NFC')
  if (mode === 'password') return nfc
  // secret-answer: casefold + trim + collapse internal whitespace runs
  return nfc.toLowerCase().trim().replace(/\s+/g, ' ')
}
