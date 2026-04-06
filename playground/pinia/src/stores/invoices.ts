import { defineNoydbStore } from '@noy-db/pinia'

/**
 * The minimal record shape we'll persist. In a real app this would
 * come from a Zod / Valibot schema and feed back through the
 * `schema:` option for runtime validation.
 */
export interface Invoice {
  id: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  client: string
  dueDate: string
}

/**
 * The whole point of v0.3: a Pinia store backed by an encrypted NOYDB
 * collection in ONE LINE. The active Noydb instance is resolved from
 * the global binding installed in `main.ts`.
 */
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo',
})
