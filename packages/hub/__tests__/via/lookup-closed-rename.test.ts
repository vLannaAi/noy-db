/**
 * #670 — `LookupHandle.rename()` self-refusal on a FRESH-declared
 * `vocabulary:'closed'` dict-tier lookup field.
 *
 * Reproduction gap: `reconcile-lookup.test.ts`'s dictKeyFieldRegistry pin
 * (line 107) deliberately uses OPEN vocabulary to isolate the late-attach
 * registry concern from this bug (see that test's own comment). No existing
 * test exercised `rename()` against a CLOSED-vocabulary field, so the
 * write-through sync-cache ordering bug (new key not visible to
 * `checkLookupMembership` until AFTER `findAndUpdateReferences` rewrites
 * referencing records) went unnoticed. RED (pre-fix): the referencing-record
 * rewrite inside `rename()` throws `UnknownLookupKeyError` for the very key
 * `rename()` just wrote.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { dict } from '../../src/via/lookup/descriptor.js'
import { UnknownLookupKeyError } from '../../src/kernel/errors.js'
import { inlineMemory } from '../classified/harness.js'

interface Order extends Record<string, unknown> { id: string; status: string }

describe('#670 — LookupHandle.rename() vs closed-vocabulary lookup fields', () => {
  it('rename() does not self-refuse: the referencing record is rewritten to the new key without UnknownLookupKeyError, and the dictionary reflects the swap', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-670-rename-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v1')
    await vault.dictionary('billing-status-670').put('paid', { en: 'Paid' })

    const orders = vault.collection<Order>('orders-670', {
      lookupFields: { status: dict('billing-status-670', { vocabulary: 'closed' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    await expect(vault.dictionary('billing-status-670').rename('paid', 'settled')).resolves.not.toThrow()

    const o1 = await orders.get('o1')
    expect(o1?.status).toBe('settled')

    const entries = await vault.dictionary('billing-status-670').list()
    expect(entries.map((e) => e.key)).toEqual(['settled'])
  })

  it('post-rename membership reflects the completed old->new transition: new key is a member, old key is fully retired', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-670-rename-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('v2')
    await vault.dictionary('billing-status-670b').put('paid', { en: 'Paid' })

    const orders = vault.collection<Order>('orders-670b', {
      lookupFields: { status: dict('billing-status-670b', { vocabulary: 'closed' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    await vault.dictionary('billing-status-670b').rename('paid', 'settled')

    // The new key is a member post-rename (a fresh write against it is accepted)...
    await expect(orders.put('o2', { id: 'o2', status: 'settled' })).resolves.not.toThrow()
    // ...and the old key is no longer a member (rename()'s step 4 fully retired it).
    await expect(orders.put('o3', { id: 'o3', status: 'paid' })).rejects.toThrow(UnknownLookupKeyError)
  })
})
