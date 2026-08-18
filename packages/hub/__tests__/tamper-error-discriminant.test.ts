/**
 * `TamperedError` distinguishes a format transition from an attack (#1103).
 *
 * ## Why this exists
 *
 * #1041 switched identity AAD on in `0.6.0-pre.18`, so records written by any
 * earlier version now fail their tag check. That failure arrives as
 * `TamperedError` — the same error, with the same message and no discriminant,
 * that the docs describe as *"a modified envelope"* and instruct the reader to
 * treat as a security alert.
 *
 * So an honest upgrade on honest data raises the product's central security
 * alarm, and the documentation confirms the wrong reading. Three silos hit this
 * independently. The sharpest framing of the cost is not the confusion: **a
 * tamper alarm that cries wolf is one users learn to ignore.**
 *
 * ## The probe, and the one property that makes it safe
 *
 * Pre-#1041 bodies carry no AAD, so they open under an empty one — positive
 * evidence of the legacy format, since forging a body that decrypts under this
 * DEK needs the DEK.
 *
 * **It classifies and nothing else.** The retry's plaintext is discarded and
 * the call still throws. Row 4 is the guard on that, and it is the row to keep
 * if any others are ever dropped: a variant that returned the retry's plaintext
 * would be precisely the accept-without-AAD downgrade #1041 was built to
 * remove.
 */
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt, generateDEK } from '../src/kernel/enclave/crypto.js'
import { buildRecordAad } from '../src/kernel/enclave/record-aad.js'
import { TamperedError, KeyringTamperedError } from '../src/kernel/errors.js'

const BODY = JSON.stringify({ id: 'r1', amount: 4200 })
const IDENTITY = { collection: 'invoices', id: 'r1', version: 1, by: 'alice' }

async function caught(fn: () => Promise<unknown>): Promise<TamperedError> {
  try { await fn() } catch (e) { return e as TamperedError }
  throw new Error('expected a throw, got none')
}

describe('#1103 — TamperedError says WHICH failure it is', () => {
  it('1. legacy data (sealed with NO AAD) is reported as a format transition', async () => {
    // Exactly what every pre-0.6.0-pre.18 record looks like: a body sealed
    // before identity binding, read by a client that now supplies AAD.
    const dek = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek)

    const err = await caught(() => decrypt(iv, data, dek, buildRecordAad(IDENTITY)))
    expect(err).toBeInstanceOf(TamperedError)
    expect(err.reason).toBe('unbound-legacy-format')
    expect(err.message).toMatch(/sealed BEFORE record-identity binding/)
    // It must point somewhere actionable, not just describe itself.
    expect(err.message).toMatch(/#1100/)
  })

  it('2. GENUINE tampering keeps the bare security alert — no benign excuse', async () => {
    // The control that gives row 1 its meaning. If this also reported
    // "legacy", the discriminant would be a way to explain away every attack.
    const dek = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek, buildRecordAad(IDENTITY))
    const flipped = Buffer.from(data, 'base64')
    flipped[4] = (flipped[4]! ^ 0xff)

    const err = await caught(() => decrypt(iv, flipped.toString('base64'), dek, buildRecordAad(IDENTITY)))
    expect(err).toBeInstanceOf(TamperedError)
    expect(err.reason).toBeUndefined()
    expect(err.message).toMatch(/may have been tampered with/)
  })

  it('3. a RELOCATED record is an attack, not a transition — the #1041 case stays loud', async () => {
    // The bound-field cases must not be swallowed: the body here is genuine and
    // opens under its OWN identity, so a careless probe could call it benign.
    // It cannot open under an empty AAD, so it is correctly left as an alert.
    const dek = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek, buildRecordAad(IDENTITY))

    const err = await caught(() =>
      decrypt(iv, data, dek, buildRecordAad({ ...IDENTITY, collection: 'payments' })))
    expect(err.reason).toBeUndefined()
  })

  it('4. THE SAFETY PROPERTY: classification never returns data — it still throws', async () => {
    // The whole argument that this is not a downgrade. The legacy body IS
    // recoverable under an empty AAD — the probe proves that every time it
    // fires — and the caller must still get nothing.
    const dek = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek)

    // Recoverable in principle...
    expect(await decrypt(iv, data, dek)).toBe(BODY)
    // ...and refused in practice, when read at a bound identity.
    await expect(decrypt(iv, data, dek, buildRecordAad(IDENTITY))).rejects.toThrow(TamperedError)
  })

  it('5. a caller with no AAD is unaffected — no probe, no reason, same behaviour', async () => {
    // Nothing changes for plaintext collections, tombstones, or any call site
    // that passes no AAD: there is no second interpretation to test.
    const dek = await generateDEK()
    const other = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek)

    const err = await caught(() => decrypt(iv, data, other))
    expect(err.reason).toBeUndefined()
  })

  it('6. `instanceof TamperedError` still works — the field is additive', async () => {
    // Every existing `catch (e) { if (e instanceof TamperedError) … }` in the
    // family must keep behaving identically; only new code reads `reason`.
    const dek = await generateDEK()
    const { iv, data } = await encrypt(BODY, dek)
    const err = await caught(() => decrypt(iv, data, dek, buildRecordAad(IDENTITY)))
    expect(err).toBeInstanceOf(TamperedError)
    expect(err.name).toBe('TamperedError')
    expect((err as unknown as { code: string }).code).toBe('TAMPERED')
  })
})

/**
 * #1129 — what an UPGRADING user reads.
 *
 * `roster_tag` and the `_roster` key ship first in `0.6.0-pre.21`, so no keyring
 * written by any earlier release carries either. On upgrade day the base rate
 * for the absence labels is ~100% benign. Verified across published tarballs:
 * a `pre.20`-written vault opened by `pre.21` throws `roster-key-missing` — the
 * roster-key check precedes the tag check, so that is the label an upgrade hits,
 * not `roster-tag-missing`.
 *
 * The refusal is correct and stays. What these rows pin is that the TEXT does
 * not accuse the user's storage of an attack it cannot demonstrate — a store
 * strips those fields with no key at all, so the states are indistinguishable
 * and the message must say so rather than pick the alarming reading.
 */
describe('#1129 — the absence labels read as a format transition, not an accusation', () => {
  const absence = ['canary-missing', 'roster-key-missing', 'roster-tag-missing'] as const

  it.each(absence)('%s names the upgrade case first, and still refuses', (reason) => {
    const msg = new KeyringTamperedError({ userId: 'bob', reason }).message
    expect(msg).toContain('0.6.0-pre.21')
    expect(msg).toMatch(/re-seeded|migration/)
    // Both readings present — the alarm is not dropped, it is put in proportion.
    expect(msg).toMatch(/untrusted store|escape verification/)
    expect(msg).toContain('refused')
    // And it must NOT lead with the bare accusation the first draft carried.
    expect(msg).not.toContain('The store serving this vault may have altered the roster.')
  })

  it('a MISMATCH keeps the unqualified alert — no released version wrote one', () => {
    // The asymmetry is the point: absence is a format state, a mismatched tag
    // is not reachable by any format transition.
    const msg = new KeyringTamperedError({ userId: 'bob', reason: 'roster-tag-mismatch' }).message
    expect(msg).toMatch(/altered after they were signed|has changed a member/)
    expect(msg).not.toContain('most likely written before')
  })

  it('unparseable points at the tools instead of at an attacker', () => {
    const msg = new KeyringTamperedError({ userId: 'bob', reason: 'unparseable' }).message
    expect(msg).toMatch(/truncation or corruption/)
    expect(msg).toContain('verifyRoster()')
  })
})
