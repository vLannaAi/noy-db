/**
 * #1459 — a business date that is a STRING is validated, not merely typed.
 *
 * #1455 made the period guard refuse a `dateField` value that is neither a
 * string nor a `Date`, and rewrote `ClosePeriodOptions.endDate`'s docstring to
 * say a non-ISO value is refused. That was true of numbers, booleans and
 * objects — and false of strings, which went straight into the lexicographic
 * comparison with no shape check at all.
 *
 * ⛔ THE DANGEROUS CASE IS NOT THE OBVIOUS ONE. `'hello'` being written is a
 * docstring that lies; `'2026-6-15'` is a defect. It is a human-legible June
 * date missing one zero, and because the comparison is lexicographic it sorts
 * ABOVE `'2026-06-30'` — so a record that belongs in a sealed June cell is
 * waved through, or caught by the wrong period, on padding alone.
 *
 * ⭐ AND TWO CASES WERE PASSING FOR THE WRONG REASON, which is why a wider
 * table of "does it refuse bad input" would have read green: `''` and
 * `'15/06/2026'` were refused only because they happen to sort BELOW every
 * plausible `endDate`. The gate fired; it fired for a reason that has nothing
 * to do with dates. Both are pinned below with that stated, so a later
 * "simplification" that removes the shape check cannot claim they still pass.
 *
 * THE GRAMMAR, and why it is narrower than "a valid ISO string": the
 * comparison against `endDate` is lexicographic, so the accepted set is
 * exactly the set that ORDERS correctly — zero-padded `YYYY-MM-DD`, optionally
 * followed by a time. That is a different question from the one
 * `query/civil-date.ts` answers (`civilDateOf` accepts `\d{1,2}` because it
 * resolves to a real day and never compares as text), which is why this does
 * not reuse it. A partial date like `'2026-06'` is refused for the same
 * reason: it names a month, sorts before every day in it, and would be sealed
 * by a close on the 1st.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ValidationError, PeriodClosedError } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withPeriods } from '../src/with-audit/periods/index.js'

interface Entry extends Record<string, unknown> { id: string; date: string | Date | null; amount: number }

const SECRET = 'issue-1459-period-date-validation-secret'

async function vaultWithJuneClosed() {
  const db = await createNoydb({
    store: memoryStore(),
    user: 'owner',
    secret: SECRET,
    periodsStrategy: withPeriods(),
  })
  const vault = await db.openVault('books')
  const entries = vault.collection<Entry>('entries')
  await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date' })
  return { vault, entries }
}

describe('#1459 — a malformed date string is refused, not compared', () => {
  it('⛔ REFUSES the zero-padding case, which is the one that seals wrongly', async () => {
    const { entries } = await vaultWithJuneClosed()
    // `'2026-6-15' > '2026-06-30'` as text, so before this fix the record was
    // WRITTEN — a June entry admitted into a closed June.
    await expect(
      entries.put('e1', { id: 'e1', date: '2026-6-15', amount: 100 }),
    ).rejects.toThrow(ValidationError)
    await expect(
      entries.put('e1', { id: 'e1', date: '2026-6-15', amount: 100 }),
    ).rejects.toThrow(/date/)
  })

  it('refuses a string that is not a date at all', async () => {
    const { entries } = await vaultWithJuneClosed()
    await expect(entries.put('e2', { id: 'e2', date: 'hello', amount: 1 })).rejects.toThrow(ValidationError)
  })

  it('refuses the two that used to pass by accident, and now fail for the right reason', async () => {
    const { entries } = await vaultWithJuneClosed()
    // Both sort below '2026-06-30', so both were previously refused with
    // PeriodClosedError — the period gate firing on garbage. The distinction
    // is the error TYPE: a malformed value is a ValidationError about the
    // input, not a statement that the record belongs to a sealed period.
    for (const bad of ['', '15/06/2026']) {
      const p = entries.put('e3', { id: 'e3', date: bad, amount: 1 })
      await expect(p).rejects.toThrow(ValidationError)
      await expect(p).rejects.not.toThrow(PeriodClosedError)
    }
  })

  it('refuses a component that names nothing real, at any granularity', async () => {
    const { entries } = await vaultWithJuneClosed()
    for (const bad of ['2026-13-01', '2026-02-30', '2026-13']) {
      await expect(
        entries.put('e4', { id: 'e4', date: bad, amount: 1 }),
        `expected ${bad} to be refused`,
      ).rejects.toThrow(ValidationError)
    }
  })

  it('names the field and the offending value, so the fix is in the message', async () => {
    const { entries } = await vaultWithJuneClosed()
    try {
      await entries.put('e5', { id: 'e5', date: '2026-6-15', amount: 1 })
      expect.unreachable('a malformed business date must be refused')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('date')
      expect(msg).toContain('2026-6-15')
    }
  })
})

describe('#1459 — every well-formed shape still writes', () => {
  it('accepts a padded calendar date outside the closed period', async () => {
    const { entries } = await vaultWithJuneClosed()
    await entries.put('ok1', { id: 'ok1', date: '2026-07-15', amount: 1 })
    expect((await entries.get('ok1'))?.amount).toBe(1)
  })

  it('accepts a full ISO timestamp, and a Date, unchanged', async () => {
    const { entries } = await vaultWithJuneClosed()
    await entries.put('ok2', { id: 'ok2', date: '2026-07-15T09:30:00.000Z', amount: 2 })
    await entries.put('ok3', { id: 'ok3', date: new Date('2026-07-16T00:00:00Z'), amount: 3 })
    expect((await entries.get('ok2'))?.amount).toBe(2)
    expect((await entries.get('ok3'))?.amount).toBe(3)
  })

  it('still treats absent and null as "no business date" (#1455), not as malformed', async () => {
    const { entries } = await vaultWithJuneClosed()
    await entries.put('ok4', { id: 'ok4', date: null, amount: 4 })
    await entries.put('ok5', { id: 'ok5', amount: 5 } as unknown as Entry)
    expect((await entries.get('ok4'))?.amount).toBe(4)
    expect((await entries.get('ok5'))?.amount).toBe(5)
  })


  it('⭐ ACCEPTS a coarser date — the first draft of this fix refused it, and the suite said no', async () => {
    // `'2026-01'` is how a monthly billing cycle is written, and
    // `__tests__/1452-periods-gate-blob-writes.test.ts` seals exactly that
    // field. Refusing partial dates "because they sort before every day in the
    // month" was wrong twice over: sorting before every day in January is what
    // makes a January cycle sealed by a January close and by nothing earlier,
    // and granularity is the caller's business. The rule is ZERO-PADDING,
    // which is what ordering actually needs.
    const { entries } = await vaultWithJuneClosed()
    await entries.put('coarse1', { id: 'coarse1', date: '2026-07', amount: 1 })
    await entries.put('coarse2', { id: 'coarse2', date: '2027', amount: 2 })
    expect((await entries.get('coarse1'))?.amount).toBe(1)
    expect((await entries.get('coarse2'))?.amount).toBe(2)
    // …and a coarse date INSIDE the closed period is still sealed.
    await expect(
      entries.put('coarse3', { id: 'coarse3', date: '2026-06', amount: 3 }),
    ).rejects.toThrow(PeriodClosedError)
  })

  it('still SEALS a well-formed date inside the closed period', async () => {
    // The negative control for the whole file: validation must not become a
    // way past the gate.
    const { entries } = await vaultWithJuneClosed()
    await expect(
      entries.put('sealed', { id: 'sealed', date: '2026-06-15', amount: 9 }),
    ).rejects.toThrow(PeriodClosedError)
  })
})

describe('#1459 — closePeriod refuses a malformed endDate at the close, not later', () => {
  it('refuses an unpadded endDate', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET, periodsStrategy: withPeriods() })
    const vault = await db.openVault('v')
    await expect(
      vault.closePeriod({ name: 'bad', endDate: '2026-6-30', dateField: 'date' }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a non-date endDate, and still accepts both well-formed shapes', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET, periodsStrategy: withPeriods() })
    const vault = await db.openVault('v')
    await expect(vault.closePeriod({ name: 'bad2', endDate: 'end of June' })).rejects.toThrow(ValidationError)
    await expect(vault.closePeriod({ name: 'q2', endDate: '2026-06-30' })).resolves.toBeDefined()
    await expect(vault.closePeriod({ name: 'q3', endDate: '2026-09-30T23:59:59.999Z' })).resolves.toBeDefined()
  })
})
