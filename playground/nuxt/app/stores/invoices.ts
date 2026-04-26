/**
 * Invoices store — declared entirely through `defineNoydbStore`,
 * backed by a Zod schema for schema validation.
 *
 * The reference demo uses a Standard Schema v1 validator; every
 * mutation / read is validated at the encrypt/decrypt boundary inside
 * @noy-db/hub.
 *
 * Components use ONLY the Pinia API — no direct Vault/Collection calls.
 * Encryption, keyring, store, and schema wiring are all invisible at the
 * call site.
 */

import { z } from 'zod'

// defineNoydbStore is auto-imported by @noy-db/in-nuxt

export const InvoiceSchema = z.object({
  id: z.string().min(1),
  client: z.string().min(1),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid', 'overdue']),
  dueDate: z.string(),
  notes: z.string().optional(),
})

// The interface is inferred from the schema so there's exactly one
// source of truth. Changing the schema automatically updates the
// type — no manual sync needed.
export type Invoice = z.infer<typeof InvoiceSchema>

/**
 * Store id matches the vault+collection hierarchy: 'demo-co' is
 * a single tenant vault in this demo. Real apps would open a
 * vault per tenant.
 */
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  vault: 'demo-co',
  schema: InvoiceSchema,
})
