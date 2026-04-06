/**
 * Invoices store — declared entirely through `defineNoydbStore`.
 *
 * This file is the v0.3 acceptance-criterion evidence:
 * "Reference Vue/Nuxt accounting demo uses ONLY the Pinia API —
 * no direct Compartment/Collection calls in components."
 *
 * If the component needs to read an invoice, it calls
 * `useInvoices().byId(id)`. If it wants to filter, it uses
 * `useInvoices().query().where(...)`. Encryption, keyring, and adapter
 * wiring are invisible.
 */

// defineNoydbStore is auto-imported by @noy-db/nuxt

export interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  dueDate: string
  notes?: string
}

/**
 * Store id matches the compartment+collection hierarchy: 'demo-co' is
 * a single tenant compartment in this demo. Real apps would open a
 * compartment per tenant.
 */
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
