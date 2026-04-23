/**
 * **@noy-db/in-tanstack-table** — TanStack Table bridge for noy-db.
 *
 * Two-way binding between TanStack Table's state (sorting, filtering,
 * pagination) and noy-db's query DSL:
 *
 *   - {@link buildQueryFromTableState}  applies Table state to a
 *     noy-db `Query<T>` chain — the returned chain is ready for a
 *     terminal `.toArray()` / `.count()` / `.aggregate()`.
 *
 *   - {@link tableStateFromQuery}        pulls the Table-shaped state
 *     back out of a query chain, for consumers that want
 *     round-tripping (URL state, localStorage, etc.).
 *
 * This is a pure adapter — no React / Vue / Solid coupling. Pair with
 * the framework binding of your choice (`@tanstack/react-table`,
 * `@tanstack/vue-table`, …) to wire it up in a component.
 *
 * @packageDocumentation
 */

import type { Query } from '@noy-db/hub'

export interface TableSortDescriptor {
  readonly id: string
  readonly desc: boolean
}

export interface TableFilterDescriptor {
  readonly id: string
  readonly value: unknown
}

export interface TablePaginationState {
  readonly pageIndex: number
  readonly pageSize: number
}

export interface TableState {
  readonly sorting?: readonly TableSortDescriptor[]
  readonly columnFilters?: readonly TableFilterDescriptor[]
  readonly pagination?: TablePaginationState
}

/**
 * Apply TanStack Table state to a noy-db `Query<T>` chain. Filters
 * are applied as `.where(id, '==', value)`; sorts as repeated
 * `.orderBy(id, 'desc' | 'asc')`; pagination as `.offset().limit()`.
 *
 * Consumers that need richer operators (`in`, `>=`, range) should
 * extend this with a custom `filterMapper` argument — this adapter
 * covers the 80% case cleanly.
 */
export function buildQueryFromTableState<T>(
  query: Query<T>,
  state: TableState,
): Query<T> {
  let chain = query
  for (const filter of state.columnFilters ?? []) {
    if (filter.value === undefined || filter.value === null || filter.value === '') continue
    // Treat arrays as `in`, everything else as `==`.
    if (Array.isArray(filter.value)) {
      chain = chain.where(filter.id as keyof T & string, 'in', filter.value as unknown[])
    } else {
      chain = chain.where(filter.id as keyof T & string, '==', filter.value)
    }
  }
  for (const sort of state.sorting ?? []) {
    chain = chain.orderBy(sort.id as keyof T & string, sort.desc ? 'desc' : 'asc')
  }
  const pag = state.pagination
  if (pag) {
    const offset = pag.pageIndex * pag.pageSize
    if (offset > 0) chain = chain.offset(offset)
    if (pag.pageSize > 0) chain = chain.limit(pag.pageSize)
  }
  return chain
}

/**
 * Extract TanStack-Table-shaped state from a query chain for
 * serialization (URL, localStorage). Returns only what the query has
 * explicitly set — undefined fields stay undefined.
 */
export function tableStateFromQuery<T>(query: Query<T>): TableState {
  const q = query as unknown as {
    __clauses?: Array<{ field: string; op: string; value: unknown }>
    __sorts?: Array<{ field: string; direction: 'asc' | 'desc' }>
    __limit?: number
    __offset?: number
  }

  const columnFilters: TableFilterDescriptor[] | undefined = q.__clauses
    ?.filter(c => c.op === '==' || c.op === 'in')
    .map(c => ({ id: c.field, value: c.value }))
  const sorting: TableSortDescriptor[] | undefined = q.__sorts?.map(s => ({
    id: s.field,
    desc: s.direction === 'desc',
  }))
  const pagination: TablePaginationState | undefined =
    q.__limit !== undefined
      ? {
          pageSize: q.__limit,
          pageIndex: q.__offset && q.__limit ? Math.floor(q.__offset / q.__limit) : 0,
        }
      : undefined

  const state: TableState = {}
  if (columnFilters && columnFilters.length > 0) (state as { columnFilters?: readonly TableFilterDescriptor[] }).columnFilters = columnFilters
  if (sorting && sorting.length > 0) (state as { sorting?: readonly TableSortDescriptor[] }).sorting = sorting
  if (pagination) (state as { pagination?: TablePaginationState }).pagination = pagination
  return state
}

/**
 * Produce a `TableState` that represents "no filter / no sort /
 * first-page pagination". Useful as a reset function for user-facing
 * clear-all buttons.
 */
export function resetTableState(pageSize = 25): TableState {
  return {
    sorting: [],
    columnFilters: [],
    pagination: { pageIndex: 0, pageSize },
  }
}
