import { describe, it, expect } from 'vitest'
import { Query } from '../../src/query/builder.js'
import type { QuerySource } from '../../src/query/builder.js'
import type { JoinContext } from '../../src/query/join.js'

function emptySource<T>(): QuerySource<T> {
  return { snapshot: () => [] as readonly T[] }
}

interface TestRow extends Record<string, unknown> {
  id: string
}

describe('analyzeDependencies', () => {
  it('captures the root collection from JoinContext', async () => {
    const { analyzeDependencies } = await import('../../src/materialized-views/dependency-analyzer.js')
    const joinContext: JoinContext = {
      leftCollection: 'invoices',
      resolveRef: () => null,
      resolveSource: () => null,
    }
    const q = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext)
    const deps = analyzeDependencies(q)
    expect(deps.has('invoices')).toBe(true)
    expect(deps.size).toBe(1)
  })

  it('captures FK join targets from plan.joins', async () => {
    const { analyzeDependencies } = await import('../../src/materialized-views/dependency-analyzer.js')
    const joinContext: JoinContext = {
      leftCollection: 'invoices',
      resolveRef: (field) => {
        if (field === 'clientId') {
          return { target: 'clients', mode: 'strict' as const }
        }
        return null
      },
      resolveSource: () => null,
    }
    const q = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext).join('clientId', { as: 'client' })
    const deps = analyzeDependencies(q)
    expect(deps.has('invoices')).toBe(true)
    expect(deps.has('clients')).toBe(true)
    expect(deps.size).toBe(2)
  })

  it('returns empty deps when no JoinContext is attached (ad-hoc Query)', async () => {
    const { analyzeDependencies } = await import('../../src/materialized-views/dependency-analyzer.js')
    const q = new Query<TestRow>(emptySource<TestRow>())
    const deps = analyzeDependencies(q)
    expect(deps.size).toBe(0)
  })
})

describe('summarizeQueryPlan', () => {
  it('is deterministic for the same plan', async () => {
    const { summarizeQueryPlan } = await import('../../src/materialized-views/dependency-analyzer.js')
    const joinContext: JoinContext = {
      leftCollection: 'invoices',
      resolveRef: () => null,
      resolveSource: () => null,
    }
    const q1 = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext).where('status', '==', 'open')
    const q2 = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext).where('status', '==', 'open')
    expect(summarizeQueryPlan(q1)).toBe(summarizeQueryPlan(q2))
  })

  it('differs when where-clause value changes', async () => {
    const { summarizeQueryPlan } = await import('../../src/materialized-views/dependency-analyzer.js')
    const joinContext: JoinContext = {
      leftCollection: 'invoices',
      resolveRef: () => null,
      resolveSource: () => null,
    }
    const q1 = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext).where('status', '==', 'open')
    const q2 = new Query<TestRow>(emptySource<TestRow>(), undefined, joinContext).where('status', '==', 'paid')
    expect(summarizeQueryPlan(q1)).not.toBe(summarizeQueryPlan(q2))
  })
})
