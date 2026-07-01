/**
 * #79 — STRICT_POLICY enroll-user / revoke-user gates wired through
 * db.grant and db.revoke.
 *
 * Pre-fix, both methods routed through the legacy
 * checkPolicyOperation('grant'|'revoke') only — the gates defined in
 * presets.ts were never invoked, so STRICT_POLICY silently failed to
 * enforce TOTP / email-OTP requirements.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb } from '../src/noydb.js'
import { PolicyDeniedError } from '../src/policy/errors.js'
import { STRICT_POLICY } from '../src/policy/presets.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c, col, id) { return gc(c, col).get(id) },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const STRICT_PHRASE = 'correct horse battery staple printer toaster picnic'

async function bootstrap(): Promise<{ db: Awaited<ReturnType<typeof createNoydb>>; store: NoydbStore }> {
  const store = inlineMemory()
  const db = await createNoydb({
    store,
    user: 'alice',
    secret: STRICT_PHRASE,
    policy: STRICT_POLICY,
  })
  await db.openVault('acme')
  return { db, store }
}

describe('STRICT_POLICY enroll-user gate (#79)', () => {
  it('rejects db.grant without factor proof', async () => {
    const { db } = await bootstrap()
    await expect(
      db.grant('acme', {
        userId: 'bob',
        displayName: 'Bob',
        role: 'operator',
        passphrase: 'glasses cabinet bicycle umbrella thunder velvet',
        permissions: { invoices: 'rw' },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  }, 60_000)

  it('accepts db.grant with a TOTP factor proof', async () => {
    const { db } = await bootstrap()
    await expect(
      db.grant(
        'acme',
        {
          userId: 'bob',
          displayName: 'Bob',
          role: 'operator',
          passphrase: 'glasses cabinet bicycle umbrella thunder velvet',
          permissions: { invoices: 'rw' },
        },
        { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] },
      ),
    ).resolves.toBeUndefined()
  }, 60_000)
})

describe('STRICT_POLICY revoke-user gate (#79)', () => {
  it('rejects db.revoke without factor proof', async () => {
    const { db } = await bootstrap()
    await db.grant(
      'acme',
      {
        userId: 'bob',
        displayName: 'Bob',
        role: 'operator',
        passphrase: 'glasses cabinet bicycle umbrella thunder velvet',
        permissions: { invoices: 'rw' },
      },
      { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] },
    )

    await expect(
      db.revoke('acme', { userId: 'bob' }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  }, 60_000)

  it('accepts db.revoke with a TOTP factor proof', async () => {
    const { db } = await bootstrap()
    await db.grant(
      'acme',
      {
        userId: 'bob',
        displayName: 'Bob',
        role: 'operator',
        passphrase: 'glasses cabinet bicycle umbrella thunder velvet',
        permissions: { invoices: 'rw' },
      },
      { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] },
    )

    await expect(
      db.revoke(
        'acme',
        { userId: 'bob' },
        { factors: [{ kind: 'totp', mintedAt: new Date().toISOString() }] },
      ),
    ).resolves.toBeUndefined()
  }, 60_000)
})
