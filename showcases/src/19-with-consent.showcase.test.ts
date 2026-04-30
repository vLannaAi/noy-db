/**
 * Showcase 19 — withConsent()
 *
 * What you'll learn
 * ─────────────────
 * `vault.withConsent({ purpose, consentHash }, fn)` runs `fn` under
 * a consent scope. Every read / write inside writes one entry to
 * `_consent_audit` with the scope's purpose + consent hash. Outside
 * a scope, no entries land — consent logging is opt-in by design,
 * which keeps the audit collection small and meaningful.
 *
 * Why it matters
 * ──────────────
 * GDPR / HIPAA / sectoral data laws require an answer to "why was
 * this record accessed?" The consent subsystem makes that question
 * answerable at the line where the access happened, with a hash
 * pointer to the consent document the user signed.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 20-with-transactions (atomic multi-record ops)
 *   - docs/subsystems/consent.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → consent
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withConsent } from '@noy-db/hub/consent'
import { memory } from '@noy-db/to-memory'

interface PatientNote { id: string; patientId: string; text: string }

describe('Showcase 19 — withConsent()', () => {
  it('records consent audit entries inside a withConsent scope', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-consent-passphrase-2026',
      consentStrategy: withConsent(),
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<PatientNote>('notes')

    // Outside the scope: no audit entries.
    await notes.put('n1', { id: 'n1', patientId: 'p-001', text: 'pre-consent' })
    expect(await vault.consentAudit({})).toEqual([])

    // Inside a scope: every access writes an audit entry.
    await vault.withConsent(
      { purpose: 'quarterly-review', consentHash: '7f3a-q1-2026' },
      async () => {
        await notes.get('n1')
        await notes.put('n2', { id: 'n2', patientId: 'p-001', text: 'within consent' })
      },
    )

    const audit = await vault.consentAudit({})
    expect(audit.length).toBeGreaterThanOrEqual(2)
    expect(audit.every((e) => e.purpose === 'quarterly-review')).toBe(true)
    expect(audit.every((e) => e.consentHash === '7f3a-q1-2026')).toBe(true)

    db.close()
  })
})
