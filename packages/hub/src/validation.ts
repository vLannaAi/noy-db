import { ValidationError } from './errors.js'

/**
 * Validate passphrase strength.
 * Checks length and basic entropy heuristics.
 * Throws ValidationError if too weak.
 */
export function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 8) {
    throw new ValidationError(
      'Passphrase too short — minimum 8 characters. ' +
      'Recommended: 12+ characters or a 4+ word passphrase.',
    )
  }

  const entropy = estimateEntropy(passphrase)
  if (entropy < 28) {
    throw new ValidationError(
      'Passphrase too weak — too little entropy. ' +
      'Use a mix of uppercase, lowercase, numbers, and symbols, ' +
      'or use a 4+ word passphrase.',
    )
  }
}

/**
 * Estimate passphrase entropy in bits.
 * Uses character class analysis (not dictionary-based).
 */
export function estimateEntropy(passphrase: string): number {
  let charsetSize = 0

  if (/[a-z]/.test(passphrase)) charsetSize += 26
  if (/[A-Z]/.test(passphrase)) charsetSize += 26
  if (/[0-9]/.test(passphrase)) charsetSize += 10
  if (/[^a-zA-Z0-9]/.test(passphrase)) charsetSize += 32

  if (charsetSize === 0) charsetSize = 26 // fallback

  return Math.floor(passphrase.length * Math.log2(charsetSize))
}
