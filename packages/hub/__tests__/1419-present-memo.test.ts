/**
 * #1419 — a warm `list()` must not re-decorate rows nothing has changed.
 *
 * The Via `present()` pass — money decode plus its `<field>Formatted` /
 * `<field>Number` siblings, i18n resolution, dictKey labels, virtual computed
 * projection — ran per row per call, on a snapshot that was already decrypted.
 * Measured: a warm `list()` of 10,336 rows cost 294 ms (28.5 us/row) against a
 * 5.5 ms full predicate scan of the same rows.
 *
 * ⛔ THE MEMO IS KEYED ON THE RECORD OBJECT, so most of this file is about the
 * things that must NOT share an entry — a different locale, a different
 * fallback chain, a different resolution layer — and about the row that was
 * actually written being re-presented while its 9,999 neighbours are not.
 * A presentation memo that ignored the locale would be invisible in the
 * default-locale tests and wrong for every consumer that passes one.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { money } from '../src/via/money/index.js'
import { memoizePresent, presentVariantKey } from '../src/kernel/present-cache.js'

interface Row { id: string; amount: number; note: string }

/**
 * ⚠️ `Intl.NumberFormat` separates the currency code from the digits with a
 * NON-BREAKING space (U+00A0), and `JSON.stringify` renders it identically to
 * a plain one — so a failing assertion prints two strings that look equal.
 * Normalise before comparing; do not "fix" the expectation by retyping it.
 */
const nbsp = (s: unknown): string => String(s).replace(/\u00a0/g, ' ')

const SECRET = 'issue-1419-present-memo-secret'

async function makeCol(): Promise<{
  col: Awaited<ReturnType<typeof open>>
}> {
  const col = await open()
  return { col }
}

async function open() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: SECRET })
  const vault = await db.openVault('V')
  return vault.collection<Row>('rows', {
    moneyFields: { amount: money({ currency: 'THB', scale: 2 }) },
  } as never)
}

async function seed(count: number) {
  const { col } = await makeCol()
  for (let i = 0; i < count; i++) {
    await col.put(`r${i}`, { id: `r${i}`, amount: i * 100, note: `n${i}` })
  }
  return col
}

describe('#1419 — a warm list() still answers correctly', () => {
  it('the second list() is value-identical to the first', async () => {
    const col = await seed(20)

    const first = await col.list()
    const second = await col.list()

    expect(second.map(r => ({ ...r }))).toEqual(first.map(r => ({ ...r })))
    // The decoration is actually present — otherwise this file would pass on
    // a collection with nothing to decorate.
    expect(first[0]).toMatchObject({ amount: '0.00', amountNumber: 0 })
    expect(nbsp((first[0] as unknown as Record<string, unknown>)['amountFormatted'])).toBe('THB 0.00')
  })

  it('get() and list() agree on a memoized row', async () => {
    const col = await seed(5)

    await col.list()
    const got = await col.get('r3')
    const listed = (await col.list()).find(r => r.id === 'r3')

    expect({ ...(got as object) }).toEqual({ ...(listed as object) })
  })
})

describe('#1419 — the memo cannot outlive the row it decorates', () => {
  it('an UPDATED row is re-decorated on the next list()', async () => {
    const col = await seed(10)
    await col.list()

    await col.put('r4', { id: 'r4', amount: 999_00, note: 'changed' })

    const after = (await col.list()).find(r => r.id === 'r4')!
    expect(after).toMatchObject({ note: 'changed', amount: '99900.00', amountNumber: 99_900 })
  })

  it('a DELETED row is gone, and its neighbours are untouched', async () => {
    const col = await seed(10)
    const before = await col.list()

    await col.delete('r4')

    const after = await col.list()
    expect(after.map(r => r.id)).not.toContain('r4')
    expect(after).toHaveLength(before.length - 1)
    expect(after.find(r => r.id === 'r5')).toMatchObject({ amount: '500.00' })
  })

  it('a NEW row appears fully decorated', async () => {
    const col = await seed(3)
    await col.list()

    await col.put('rNew', { id: 'rNew', amount: 4_242, note: 'new' })

    const added = (await col.list()).find(r => r.id === 'rNew')!
    expect(added).toMatchObject({ amount: '4242.00', amountNumber: 4242 })
    expect(nbsp((added as unknown as Record<string, unknown>)['amountFormatted'])).toBe('THB 4,242.00')
  })
})

describe('#1419 — variants must not share an entry', () => {
  it('a different locale is presented separately', async () => {
    const col = await seed(3)

    // Warm the default-locale entry first: a memo that ignored the locale
    // would serve this back for the 'raw' read below.
    const dressed = (await col.list())[0]!
    const raw = (await col.list({ locale: 'raw' }))[0]!

    expect(dressed).toHaveProperty('amountFormatted')
    // 'raw' suppresses the locale-formatted virtuals by design.
    expect(raw).not.toHaveProperty('amountFormatted')
  })

  it('presentVariantKey separates locale, layer and fallback chain', () => {
    const k = presentVariantKey
    expect(k('th', 'read', undefined)).not.toBe(k('en', 'read', undefined))
    expect(k('th', 'read', undefined)).not.toBe(k('th', 'guard', undefined))
    expect(k('th', 'read', 'en')).not.toBe(k('th', 'read', undefined))

    // A chain is joined, not stringified: these are different requests.
    expect(k('th', 'read', ['en', 'any'])).not.toBe(k('th', 'read', 'en'))
    // ...and equal inputs still collapse to one entry.
    expect(k('th', 'read', ['en', 'any'])).toBe(k('th', 'read', ['en', 'any']))
    expect(k(undefined, 'read', undefined)).toBe(k(undefined, 'read', undefined))
  })
})

describe('#1419 — memoizePresent contract', () => {
  it('computes once per (record, variant) and shares concurrent callers', async () => {
    const record = { a: 1 }
    let calls = 0
    const compute = async (): Promise<string> => {
      calls++
      await Promise.resolve()
      return 'done'
    }

    // Concurrent: both must ride the same in-flight promise, not race.
    const [x, y] = await Promise.all([
      memoizePresent(record, 'v1', compute),
      memoizePresent(record, 'v1', compute),
    ])
    const z = await memoizePresent(record, 'v1', compute)

    expect([x, y, z]).toEqual(['done', 'done', 'done'])
    expect(calls).toBe(1)

    // A different variant of the same record is its own entry.
    await memoizePresent(record, 'v2', compute)
    expect(calls).toBe(2)

    // A different record is too.
    await memoizePresent({ a: 1 }, 'v1', compute)
    expect(calls).toBe(3)
  })

  it('does not cache a rejection — a transient failure stays transient', async () => {
    const record = { a: 1 }
    let calls = 0
    const flaky = async (): Promise<string> => {
      calls++
      await Promise.resolve()
      if (calls === 1) throw new Error('transient')
      return 'ok'
    }

    await expect(memoizePresent(record, 'v', flaky)).rejects.toThrow('transient')
    // A retained rejected promise would make this throw forever.
    await expect(memoizePresent(record, 'v', flaky)).resolves.toBe('ok')
    expect(calls).toBe(2)
  })
})

describe('#1419 — the warm read is no longer linear in the decoration', () => {
  it('a warm list() of 3000 rows costs a fraction of the cold one', async () => {
    const col = await seed(3000)

    const t0 = performance.now()
    await col.list()
    const cold = performance.now() - t0

    const t1 = performance.now()
    await col.list()
    await col.list()
    const warmPer = (performance.now() - t1) / 2

    // Deliberately loose: this guards the memo's EXISTENCE, not a millisecond
    // budget on a loaded CI box. Before the fix the two costs were equal.
    expect(warmPer).toBeLessThan(cold / 3)
  })
})
