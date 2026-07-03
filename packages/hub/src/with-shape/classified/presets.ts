/** The preset catalog (stage 1). Presets are hub-owned; devs get declarative
 *  knobs, not read-side callbacks (design law D2/D3). @module */

import type { ClassifiedFieldSpec, ClassifiedGroup } from './descriptor.js'
import { luhnCheck } from './validators.js'

const digitsOf = (v: unknown): string => String(v).replace(/\D/g, '')

function panSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.pan', storage: 'recoverable',
    sensitivity: 'secret', list: { kind: 'mask', pattern: '•••• ${last4}' },
    riders: { last4: (v) => digitsOf(v).slice(-4), bin: (v) => digitsOf(v).slice(0, 6) },
    validate: (v) => (typeof v === 'string' && luhnCheck(v) ? null : 'not a Luhn-valid card number'),
  }
}

function expirySpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.expiry', storage: 'recoverable',
    sensitivity: 'pii', list: { kind: 'mask', pattern: '••/••' },
    validate: (v) => (typeof v === 'string' && /^(0[1-9]|1[0-2])\/\d{2}$/.test(v) ? null : 'expected MM/YY'),
  }
}

function cvcSpec(): ClassifiedFieldSpec {
  return {
    _noydbClassified: true, preset: 'creditCard.cvc', storage: 'never',
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
    return { _noydbClassifiedGroup: true, preset: 'creditCard', members }
  },

  birthDate(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'birthDate', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '${yob}-••-••' },
      riders: { yob: (v) => String(v).slice(0, 4) },
      validate: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'expected ISO yyyy-mm-dd'),
    }
  },

  email(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'email', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••@${domain}' },
      riders: { domain: (v) => String(v).split('@')[1] ?? '' },
      validate: (v) => (typeof v === 'string' && v.includes('@') ? null : 'expected an email address'),
    }
  },

  phone(): ClassifiedFieldSpec {
    return {
      _noydbClassified: true, preset: 'phone', storage: 'recoverable',
      sensitivity: 'pii', list: { kind: 'mask', pattern: '•••••${last2}' },
      riders: { last2: (v) => digitsOf(v).slice(-2) },
      validate: (v) => (digitsOf(v).length >= 5 ? null : 'expected at least 5 digits'),
    }
  },
}
