/**
 * #834 — `db.vault(name)` must never CONSTRUCT a Vault.
 *
 * It used to carry two fallback constructors (one plaintext, one encrypted)
 * beside the canonical `#openVaultFresh`. The encrypted copy had silently
 * drifted: it omitted six strategies (attestation, classified, portability,
 * sealed-record, sequence, forget), so a vault reached that way threw
 * `*NotEnabledError` for services the caller HAD configured. Both fallbacks
 * also skipped the async init `openVault` performs (`_initGuards`,
 * `_initDerivations`, `_initMaterializedViews`, `_initOverlayedViews`,
 * `schemaFence.init()`) — unavoidably, since `vault()` is synchronous.
 *
 * The fix is structural: `vault()` returns a cached instance or throws.
 * One construction path means the drift cannot recur.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { ValidationError } from '../src/kernel/errors.js'
import { withAttestation } from '../src/with-audit/attestation/index.js'
import { NO_ATTESTATION } from '../src/with-audit/attestation/strategy.js'
import { withClassified } from '../src/via/classified/index.js'
import { NO_CLASSIFIED } from '../src/port/with/classified-strategy.js'
import { withPortability } from '../src/with-audit/portability/index.js'
import { NO_PORTABILITY } from '../src/with-audit/portability/strategy.js'
import { withSealedRecord } from '../src/with-audit/sealed-record/index.js'
import { NO_SEALED_RECORD } from '../src/with-audit/sealed-record/strategy.js'
import { withSequence } from '../src/with-commit/sequence/index.js'
import { NO_SEQUENCE } from '../src/with-commit/sequence/strategy.js'
import { NO_FORGET } from '../src/with-audit/forget/strategy.js'

describe('#834 — vault() is cache-only, never a second construction path', () => {
  it('throws with an actionable message when the vault was never opened (plaintext)', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', encrypt: false })
    expect(() => db.vault('acme')).toThrowError(ValidationError)
    expect(() => db.vault('acme')).toThrowError(/openVault/)
  })

  it('throws when the vault was never opened (encrypted)', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-834-encrypted' })
    expect(() => db.vault('never-opened')).toThrowError(ValidationError)
  })

  it('throws again after lockVault evicts the instance', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-834-lock' })
    await db.openVault('acme')
    expect(db.vault('acme')).toBeDefined()
    await db.lockVault('acme')
    expect(() => db.vault('acme')).toThrowError(ValidationError)
  })

  it('returns the very instance openVault produced (identity, not a copy)', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-834-identity' })
    const opened = await db.openVault('acme')
    expect(db.vault('acme')).toBe(opened)
  })

  /**
   * The #834 symptom itself. The six strategies below are exactly the ones
   * the drifted constructor dropped; a vault missing one throws
   * `*NotEnabledError` on first use. White-box on purpose — the invariant
   * that broke was "the constructed vault carries the configured
   * strategies", and the strategy fields are private.
   */
  it('carries every strategy the caller configured, incl. the six that used to drop', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'alice',
      secret: 'pw-834-strategies',
      attestationStrategy: withAttestation(),
      classifiedStrategy: withClassified(),
      portabilityStrategy: withPortability(),
      sealedRecordStrategy: withSealedRecord(),
      sequenceStrategy: withSequence(),
      forgetStrategy: { subjects: { invoices: 'clientId' } },
    })
    await db.openVault('acme')
    const v = db.vault('acme') as unknown as Record<string, unknown>
    expect(v['attestationStrategy']).not.toBe(NO_ATTESTATION)
    expect(v['classifiedStrategy']).not.toBe(NO_CLASSIFIED)
    expect(v['portabilityStrategy']).not.toBe(NO_PORTABILITY)
    expect(v['sealedRecordStrategy']).not.toBe(NO_SEALED_RECORD)
    expect(v['sequenceStrategy']).not.toBe(NO_SEQUENCE)
    expect(v['forgetStrategy']).not.toBe(NO_FORGET)
    // Async init that only `openVault` can perform must have run.
    expect((db.vault('acme')).schemaFence).toBeDefined()
  })

  /**
   * The actual regression guard. This bug survived for as long as it did
   * because nothing asserted the invariant it broke: exactly one
   * `new Vault(...)` site in the file. A second one is how six strategies
   * went missing.
   */
  it('noydb.ts constructs a Vault in exactly ONE place', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/kernel/noydb.ts', import.meta.url)),
      'utf8',
    )
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(withoutComments.match(/new Vault\(/g) ?? []).toHaveLength(1)
  })
})
