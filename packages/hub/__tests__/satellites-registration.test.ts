/**
 * Vault registration wiring for satellite collections (#591, archetype-③).
 *
 * Drives everything through the public `createNoydb`/`openVault` API with
 * `to-memory` (fixture pattern copied from schema-introspection.test.ts).
 * Covers the thin kernel call-site in `vault.ts`: R-S3/R-S5/R-S7/R-S8/R-S9
 * sync refusals, the joined-name guard, and the async R-S1 poison cross-check.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import type { NoydbStore } from '../src/kernel/types.js'
import { memory } from '../../to-memory/src/index.js'
import { withForget } from '../src/with-audit/forget/index.js'
import type { ForgetStrategy } from '../src/with-audit/forget/strategy.js'
import { SatelliteConfigError } from '../src/kernel/errors.js'

const SECRET = 'satellite-registration-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  subject_short?: string
  body?: string
}

async function openTestVault(opts: { forgetStrategy?: ForgetStrategy } = {}) {
  const store: NoydbStore = memory()
  const db = await createNoydb({ store, user: 'alice', secret: SECRET, ...opts })
  const vault = await db.openVault('v1')
  return { vault, store }
}

describe('satellite declaration wiring (#591)', () => {
  it('registers the pair; base and satellite behave as plain collections for writes', async () => {
    const { vault, store } = await openTestVault()
    vault.collection<Msg>('msgs', {})
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
    await vault.collection<Msg>('msgs').put('x', { from: 'a', subject_short: 's' })
    // No auto-created satellite envelope (audit reversal):
    expect(await store.get('v1', 'msgs_text', 'x')).toBeNull()
  })

  it('R-S3: refuses satelliteOf pointing at a registered satellite', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] })
    expect(() => vault.collection<Msg>('deep', { satelliteOf: 'msgs_text', fields: ['x'] }))
      .toThrowError(/R-S3/)
  })

  it('R-S3: refuses satelliteOf pointing at a name that is ALREADY registered as a base (order-inverted chain)', async () => {
    const { vault } = await openTestVault()
    // "msgs_text" is declared as a BASE first (of "deep") ...
    vault.collection<Msg>('deep', { satelliteOf: 'msgs_text', fields: ['x'] })
    // ... then re-declared as a SATELLITE of "msgs" — same chain, opposite
    // declaration order; must refuse identically to the direct-order test above.
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(/R-S3/)
  })

  it('R-S7: refuses a satellite without perRecordKeys when the base is forget-covered', async () => {
    const { vault } = await openTestVault({ forgetStrategy: withForget({ subjects: { msgs: 'from' } }) })
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(/R-S7/)
    // With perRecordKeys it registers fine:
    expect(() => vault.collection<Msg>('msgs_text2', { satelliteOf: 'msgs', fields: ['body'], perRecordKeys: true }))
      .not.toThrow()
  })

  it('R-S8: refuses declaring a satellite whose base was already constructed with crdt mode', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs', { crdt: 'lww-map' })
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(/R-S8/)
  })

  it('R-S8: refuses constructing the base with crdt mode AFTER the pairing already exists', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs', {})
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] })
    expect(() => vault.collection<Msg>('msgs', { crdt: 'lww-map' }))
      .toThrowError(/R-S8/)
  })

  it('R-S5: refuses a joined name that matches an already-declared plain collection', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs_full', {})
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'], joined: 'msgs_full' }))
      .toThrowError(/R-S5/)
  })

  it('rejects vault.collection(<joinedName>) with a pointer to vault.joined()', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'], joined: 'msgs_full' })
    expect(() => vault.collection('msgs_full')).toThrowError(/vault\.joined/)
  })

  it('poisons the satellite when the async fields-vs-schema cross-check finds overlap (R-S1)', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs', { schema: z.object({ subject: z.string(), from: z.string() }) })
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })
    await vi.waitFor(async () => {
      await expect(vault.collection<Msg>('msgs_text').put('x', { subject: 's' })).rejects.toThrowError(/R-S1:/)
    })
  })

  it('idempotent re-declaration: an identical redeclare of the same satellite does not throw', () => {
    return (async () => {
      const { vault } = await openTestVault()
      vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
      expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' }))
        .not.toThrow()
    })()
  })

  it('a refused declaration leaves no side effects: registry stays null, plain writes unaffected', async () => {
    const { vault } = await openTestVault({ forgetStrategy: withForget({ subjects: { msgs: 'from' } }) })
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(SatelliteConfigError)
    // Internal invariant: the refused declaration created no registry (and thus no write hook).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((vault as any).satelliteRegistry).toBeNull()
    // A plain write on an unrelated collection flows through untouched:
    await expect(vault.collection<Msg>('notes').put('n1', { body: 'ok' })).resolves.toBeUndefined()
  })

  it('R-S9: a divergent in-session redeclaration of the same satellite name is refused', async () => {
    const { vault } = await openTestVault()
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject'] })
    expect(() => vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(/R-S9/)
  })
})
