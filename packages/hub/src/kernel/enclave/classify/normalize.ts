/**
 * Preset normalization for verify candidates AND stored comparands (§4).
 * Both sides of every comparison route through the SAME function so
 * write-time digests and verify-time candidates agree. @module
 */
export type VerifyNormalizeMode = 'password' | 'secret-answer'

export function normalizeForVerify(mode: VerifyNormalizeMode, value: string): string {
  const nfc = value.normalize('NFC')
  if (mode === 'password') return nfc
  // secret-answer: NFC -> casefold -> re-NFC -> trim -> collapse internal
  // whitespace runs. `.toLowerCase()` is the chosen casefold approximation
  // (JS has no full Unicode caseless-match in the stdlib, e.g. ß stays ß);
  // the re-NFC after lowercasing keeps the result deterministic.
  return nfc.toLowerCase().normalize('NFC').trim().replace(/\s+/g, ' ')
}
