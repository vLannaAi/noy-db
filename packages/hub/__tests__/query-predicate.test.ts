import { describe, it, expect } from 'vitest'
import {
  evaluateFieldClause,
  evaluateClause,
  readPath,
  type FieldClause,
  type Clause,
} from '../src/query/predicate.js'

// Note: Clause is non-parametric — it operates on `unknown` records at runtime.
// The Query<T> public API keeps T at its surface; predicates carry no type tag.

describe('query > readPath', () => {
  it('reads a top-level field', () => {
    expect(readPath({ a: 1 }, 'a')).toBe(1)
  })

  it('reads a nested field via dot notation', () => {
    expect(readPath({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep')
  })

  it('returns undefined for missing top-level field', () => {
    expect(readPath({ a: 1 }, 'b')).toBeUndefined()
  })

  it('returns undefined when intermediate segment is missing', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined()
  })

  it('returns undefined when input is null or undefined', () => {
    expect(readPath(null, 'a')).toBeUndefined()
    expect(readPath(undefined, 'a')).toBeUndefined()
  })
})

describe('query > evaluateFieldClause > equality operators', () => {
  const r = { status: 'open', amount: 5000 }

  it('==  matches equal primitives', () => {
    const c: FieldClause = { type: 'field', field: 'status', op: '==', value: 'open' }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })

  it('==  rejects when values differ', () => {
    const c: FieldClause = { type: 'field', field: 'status', op: '==', value: 'closed' }
    expect(evaluateFieldClause(r, c)).toBe(false)
  })

  it('!=  rejects equal primitives', () => {
    const c: FieldClause = { type: 'field', field: 'status', op: '!=', value: 'open' }
    expect(evaluateFieldClause(r, c)).toBe(false)
  })

  it('!=  matches when values differ', () => {
    const c: FieldClause = { type: 'field', field: 'status', op: '!=', value: 'closed' }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })
})

describe('query > evaluateFieldClause > comparison operators', () => {
  const r = { amount: 5000 }

  it('<  works for numbers', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: '<', value: 6000 }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })

  it('<= is inclusive', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: '<=', value: 5000 }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })

  it('>  works for numbers', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: '>', value: 4000 }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })

  it('>= is inclusive', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: '>=', value: 5000 }
    expect(evaluateFieldClause(r, c)).toBe(true)
  })

  it('comparison rejects mismatched runtime types', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: '<', value: 'six' }
    expect(evaluateFieldClause(r, c)).toBe(false)
  })

  it('comparison works for strings (lexicographic)', () => {
    const c: FieldClause = { type: 'field', field: 'name', op: '<', value: 'b' }
    expect(evaluateFieldClause({ name: 'a' }, c)).toBe(true)
  })

  it('comparison works for Date objects', () => {
    const c: FieldClause = {
      type: 'field',
      field: 'when',
      op: '<',
      value: new Date('2026-12-31'),
    }
    expect(evaluateFieldClause({ when: new Date('2026-01-01') }, c)).toBe(true)
  })
})

describe('query > evaluateFieldClause > set and string operators', () => {
  it('in  matches when value is in the array operand', () => {
    const c: FieldClause = {
      type: 'field',
      field: 'status',
      op: 'in',
      value: ['draft', 'open', 'paid'],
    }
    expect(evaluateFieldClause({ status: 'open' }, c)).toBe(true)
    expect(evaluateFieldClause({ status: 'closed' }, c)).toBe(false)
  })

  it('in  rejects when operand is not an array', () => {
    const c: FieldClause = { type: 'field', field: 'status', op: 'in', value: 'open' }
    expect(evaluateFieldClause({ status: 'open' }, c)).toBe(false)
  })

  it('contains works on strings', () => {
    const c: FieldClause = { type: 'field', field: 'name', op: 'contains', value: 'oy' }
    expect(evaluateFieldClause({ name: 'noydb' }, c)).toBe(true)
    expect(evaluateFieldClause({ name: 'other' }, c)).toBe(false)
  })

  it('contains works on arrays', () => {
    const c: FieldClause = { type: 'field', field: 'tags', op: 'contains', value: 'urgent' }
    expect(evaluateFieldClause({ tags: ['draft', 'urgent'] }, c)).toBe(true)
    expect(evaluateFieldClause({ tags: ['draft'] }, c)).toBe(false)
  })

  it('startsWith matches string prefixes', () => {
    const c: FieldClause = { type: 'field', field: 'sku', op: 'startsWith', value: 'INV-' }
    expect(evaluateFieldClause({ sku: 'INV-001' }, c)).toBe(true)
    expect(evaluateFieldClause({ sku: 'PAY-001' }, c)).toBe(false)
  })

  it('startsWith rejects non-string actuals', () => {
    const c: FieldClause = { type: 'field', field: 'n', op: 'startsWith', value: '1' }
    expect(evaluateFieldClause({ n: 1 }, c)).toBe(false)
  })

  it('between is inclusive on both bounds', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: 'between', value: [1000, 5000] }
    expect(evaluateFieldClause({ amount: 1000 }, c)).toBe(true)
    expect(evaluateFieldClause({ amount: 5000 }, c)).toBe(true)
    expect(evaluateFieldClause({ amount: 3000 }, c)).toBe(true)
    expect(evaluateFieldClause({ amount: 999 }, c)).toBe(false)
    expect(evaluateFieldClause({ amount: 5001 }, c)).toBe(false)
  })

  it('between rejects non-tuple operand', () => {
    const c: FieldClause = { type: 'field', field: 'amount', op: 'between', value: 'bad' }
    expect(evaluateFieldClause({ amount: 100 }, c)).toBe(false)
  })
})

describe('query > evaluateClause > groups and filter', () => {
  const r = { status: 'open', amount: 5000, tags: ['urgent'] }

  it('AND group requires every child to match', () => {
    const c: Clause = {
      type: 'group',
      op: 'and',
      clauses: [
        { type: 'field', field: 'status', op: '==', value: 'open' },
        { type: 'field', field: 'amount', op: '>', value: 1000 },
      ],
    }
    expect(evaluateClause(r, c)).toBe(true)
  })

  it('AND group rejects when one child fails', () => {
    const c: Clause = {
      type: 'group',
      op: 'and',
      clauses: [
        { type: 'field', field: 'status', op: '==', value: 'open' },
        { type: 'field', field: 'amount', op: '>', value: 9999 },
      ],
    }
    expect(evaluateClause(r, c)).toBe(false)
  })

  it('OR group matches when any child matches', () => {
    const c: Clause = {
      type: 'group',
      op: 'or',
      clauses: [
        { type: 'field', field: 'status', op: '==', value: 'paid' },
        { type: 'field', field: 'amount', op: '>', value: 1000 },
      ],
    }
    expect(evaluateClause(r, c)).toBe(true)
  })

  it('OR group rejects when no child matches', () => {
    const c: Clause = {
      type: 'group',
      op: 'or',
      clauses: [
        { type: 'field', field: 'status', op: '==', value: 'paid' },
        { type: 'field', field: 'amount', op: '>', value: 9999 },
      ],
    }
    expect(evaluateClause(r, c)).toBe(false)
  })

  it('filter clause runs the supplied function', () => {
    const c: Clause = { type: 'filter', fn: (rec) => (rec as { amount: number }).amount === 5000 }
    expect(evaluateClause(r, c)).toBe(true)
  })

  it('nested groups (AND inside OR) work', () => {
    const c: Clause = {
      type: 'group',
      op: 'or',
      clauses: [
        {
          type: 'group',
          op: 'and',
          clauses: [
            { type: 'field', field: 'status', op: '==', value: 'open' },
            { type: 'field', field: 'amount', op: '>', value: 1000 },
          ],
        },
        { type: 'field', field: 'status', op: '==', value: 'overdue' },
      ],
    }
    expect(evaluateClause(r, c)).toBe(true)
  })
})
