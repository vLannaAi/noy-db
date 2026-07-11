/** The preset catalog (stage 1). Presets are hub-owned; devs get declarative
 *  knobs, not read-side callbacks (design law D2/D3). @module */

import type { ClassifiedFieldSpec, ClassifiedGroup } from './descriptor.js'
import { luhnCheck } from './validators.js'

const digitsOf = (v: unknown): string => String(v).replace(/\D/g, '')

function panSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, _viaBrand: 'classified', preset: 'creditCard.pan', storage: 'recoverable',
    sensitivity: 'secret', list: { kind: 'mask', pattern: '•••• ${last4}' },
    riders: { last4: (v) => digitsOf(v).slice(-4), bin: (v) => digitsOf(v).slice(0, 6) },
    validate: (v) => (typeof v === 'string' && luhnCheck(v) ? null : 'not a Luhn-valid card number'),
  }
}

function expirySpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, _viaBrand: 'classified', preset: 'creditCard.expiry', storage: 'recoverable',
    sensitivity: 'pii', list: { kind: 'mask', pattern: '••/••' },
    validate: (v) => (typeof v === 'string' && /^(0[1-9]|1[0-2])\/\d{2}$/.test(v) ? null : 'expected MM/YY'),
  }
}

function cvcSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, _viaBrand: 'classified', preset: 'creditCard.cvc', storage: 'never',
    sensitivity: 'secret', list: { kind: 'omit' },
    validate: (v) => (typeof v === 'string' && /^\d{3,4}$/.test(v) ? null : 'expected 3-4 digits'),
  }
}

export const classified = {
  /** Composite card type. PAN sealed + last4/bin riders; CVC is storage:'never' (PCI-aware). */
  creditCard(fields: { pan: string; expiry?: string; cvc?: string }): ClassifiedGroup {
    const members: Record<string, ClassifiedFieldSpec> = { [fields.pan]: panSpec() }
    if (fields.expiry !== undefined) members[fields.expiry] = expirySpec()
    if (fields.cvc !== undefined) members[fields.cvc] = cvcSpec()
    return { _noydbClassifiedGroup: true, _viaBrand: 'classified', preset: 'creditCard', members }
  },

  birthDate(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, _viaBrand: 'classified', preset: 'birthDate', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '${yob}-••-••' },
      riders: { yob: (v) => String(v).slice(0, 4) },
      validate: (v) => {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'expected ISO yyyy-mm-dd'
        const parts = v.split('-').map(Number)
        const year = parts[0]!, month = parts[1]!, day = parts[2]!
        if (month < 1 || month > 12) return 'not a valid calendar date'
        const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
        const maxDay = month === 2 && isLeapYear ? 29 : daysInMonth[month - 1]!
        if (day < 1 || day > maxDay) return 'not a valid calendar date'
        return null
      },
    }
  },

  email(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, _viaBrand: 'classified', preset: 'email', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••@${domain}' },
      riders: { domain: (v) => String(v).split('@')[1] ?? '' },
      validate: (v) => (typeof v === 'string' && v.includes('@') ? null : 'expected an email address'),
    }
  },

  phone(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, _viaBrand: 'classified', preset: 'phone', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••••${last2}' },
      riders: { last2: (v) => digitsOf(v).slice(-2) },
      validate: (v) => (digitsOf(v).length >= 5 ? null : 'expected at least 5 digits'),
    }
  },

  /** Digest-only password: verify-without-reveal; never listed, never revealed.
   *  Enumeration math is on the caller for low-entropy values — see the
   *  per-preset docs; the hub ships no rate limiter in this slice (spec §5).
   *
   *  @param opts.equatable — emit a store-visible `_bidx` equality tag (enables
   *  `findByDigest`). Cost band you are accepting:
   *
   *  equal values produce equal store-visible tags: anyone with store access
   *  learns which records share this secret and how many share each value —
   *  never the value itself. A collection-DEK holder can additionally test
   *  candidate values offline: the tag's inner digest is PBKDF2-SHA256 (600K),
   *  which is GPU/ASIC-friendly — an offline attacker runs on the order of
   *  10⁴–10⁸ guesses/second, so for low-entropy secrets (PINs, casefolded secret
   *  answers) offline recovery of the equality partition is seconds-to-hours, not
   *  years. `crypto.subtle` exposes no memory-hard KDF (no scrypt/argon2) and the
   *  family's no-crypto-deps law forbids adding one, so PBKDF2-SHA256 is the
   *  hardest primitive available; the iteration count raises the price but does
   *  not make a low-entropy field safe. The real control for low-entropy fields
   *  is the DOOR — do not enable `equatable` for them unless the partition being
   *  learnable is acceptable — not the iteration count. Pre-forget backups retain
   *  tags. */
  password(opts: { minLength?: number; rotateDays?: number; notLastN?: number; equatable?: true } = {}): ClassifiedFieldSpec {
    const minLength = opts.minLength ?? 10
    const notLastN = opts.notLastN ?? 0
    if (!Number.isInteger(notLastN) || notLastN < 0 || notLastN > 8) {
      throw new Error(`classified.password: notLastN must be an integer 0..8 (write cost is n × 600K PBKDF2; ring blast radius is documented), got ${notLastN}`)
    }
    return {
      _noydbClassified: true, _viaBrand: 'classified', preset: 'password', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'password',
      ...(opts.rotateDays !== undefined ? { rotateDays: opts.rotateDays } : {}),
      ...(notLastN > 0 ? { notLastN } : {}),
      ...(opts.equatable === true ? { equatable: true as const } : {}),
      validate: (v) => (typeof v === 'string' && v.normalize('NFC').length >= minLength
        ? null : `password must be at least ${minLength} characters`),
    }
  },

  /** Digest-only secret answer: normalized (casefold/trim/collapse), groupable
   *  into k-of-n matchGroup challenges. Low-entropy by nature — document the
   *  enumeration math to your users; add app-side rate limiting.
   *
   *  @param opts.equatable — emit a store-visible `_bidx` equality tag (enables
   *  `findByDigest`). Cost band you are accepting:
   *
   *  equal values produce equal store-visible tags: anyone with store access
   *  learns which records share this secret and how many share each value —
   *  never the value itself. A collection-DEK holder can additionally test
   *  candidate values offline: the tag's inner digest is PBKDF2-SHA256 (600K),
   *  which is GPU/ASIC-friendly — an offline attacker runs on the order of
   *  10⁴–10⁸ guesses/second, so for low-entropy secrets (PINs, casefolded secret
   *  answers) offline recovery of the equality partition is seconds-to-hours, not
   *  years. `crypto.subtle` exposes no memory-hard KDF (no scrypt/argon2) and the
   *  family's no-crypto-deps law forbids adding one, so PBKDF2-SHA256 is the
   *  hardest primitive available; the iteration count raises the price but does
   *  not make a low-entropy field safe. The real control for low-entropy fields
   *  is the DOOR — do not enable `equatable` for them unless the partition being
   *  learnable is acceptable — not the iteration count. Pre-forget backups retain
   *  tags. */
  secretAnswer(opts: { equatable?: true } = {}): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, _viaBrand: 'classified', preset: 'secretAnswer', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'secret-answer', verifyGroupMember: true,
      ...(opts.equatable === true ? { equatable: true as const } : {}),
      validate: (v) => (typeof v === 'string'
        && v.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ').length > 0
        ? null : 'secret answer must be non-empty after normalization'),
    }
  },
}
