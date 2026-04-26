/**
 * Invoice store — reactive, encrypted, backed by a noy-db collection.
 *
 * `defineNoydbStore` wraps `defineStore` from Pinia and wires the
 * store to a vault + collection. All writes encrypt before the
 * IndexedDB adapter sees them; all reads decrypt into the reactive
 * `items` array.
 *
 * Use from components:
 *   const invoices = useInvoices()
 *   await invoices.$ready
 *   await invoices.add(id, record)
 *   invoices.items   // reactive array
 *   invoices.count   // reactive getter
 */
import { defineNoydbStore } from '@noy-db/in-pinia'

export interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  issueDate: string // ISO-8601
}

export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  vault: 'demo',
})

/** Optional seed set rendered on first load when the collection is empty. */
export const DEFAULT_INVOICES: Invoice[] = [
  { id: 'inv-001', client: 'Acme Corp', amount: 1_200, status: 'paid', issueDate: '2026-01-15' },
  { id: 'inv-002', client: 'Globex', amount: 2_400, status: 'open', issueDate: '2026-02-01' },
  { id: 'inv-003', client: 'Initech', amount: 800, status: 'draft', issueDate: '2026-02-20' },
]
