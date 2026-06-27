import type { Query } from '@noy-db/hub'

type QueryOp = '==' | '!=' | '>' | '>=' | '<' | '<='

const OP_MAP: Record<string, QueryOp> = {
  eq: '==',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

export interface ParsedQueryParams {
  error?: { error: string; op?: string }
  apply<T>(q: Query<T>): Query<T>
  limit: number | null
}

export function parseQueryParams(searchParams: URLSearchParams): ParsedQueryParams {
  const wheres = searchParams.getAll('where')
  const orderByParam = searchParams.get('orderBy')
  const limitParam = searchParams.get('limit')

  const whereClauses: Array<{ field: string; op: QueryOp; value: unknown }> = []

  for (const clause of wheres) {
    const parts = clause.split(':')
    if (parts.length < 3) {
      return {
        error: { error: 'invalid_where', op: clause },
        apply: (q) => q,
        limit: null,
      }
    }
    const field = parts[0] as string
    const opStr = parts[1] as string
    const value = parts.slice(2).join(':')
    const op = OP_MAP[opStr]
    if (!op) {
      return {
        error: { error: 'invalid_op', op: opStr },
        apply: (q) => q,
        limit: null,
      }
    }
    whereClauses.push({ field, op, value: coerce(value) })
  }

  let orderBy: { field: string; dir: 'asc' | 'desc' } | null = null
  if (orderByParam) {
    const obParts = orderByParam.split(':')
    const obField = obParts[0] as string
    const obDir = obParts[1]
    orderBy = { field: obField, dir: obDir === 'desc' ? 'desc' : 'asc' }
  }

  const limit = limitParam ? parseInt(limitParam, 10) : null

  return {
    apply<T>(q: Query<T>): Query<T> {
      let result = q
      for (const { field, op, value } of whereClauses) {
        result = result.where(field, op, value as T[keyof T & string])
      }
      if (orderBy) {
        result = result.orderBy(orderBy.field, orderBy.dir)
      }
      return result
    },
    limit,
  }
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  if (!isNaN(n) && raw.trim() !== '') return n
  return raw
}
