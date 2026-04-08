/**
 * Invoices store — declared entirely through `defineNoydbStore`, now
 * backed by a Zod schema for v0.4 validation.
 *
 * This file is the v0.4 acceptance-criterion evidence for #42: the
 * reference demo uses a Standard Schema v1 validator, and every
 * mutation / read is validated at the encrypt/decrypt boundary inside
 * @noy-db/core.
 *
 * It's also the v0.3 evidence: "Reference Vue/Nuxt accounting demo
 * uses ONLY the Pinia API — no direct Compartment/Collection calls
 * in components." Encryption, keyring, adapter, and schema wiring
 * are all invisible at the call site.
 */

import { z } from 'zod'

// defineNoydbStore is auto-imported by @noy-db/nuxt

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
 * Store id matches the compartment+collection hierarchy: 'demo-co' is
 * a single tenant compartment in this demo. Real apps would open a
 * compartment per tenant.
 */
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
  schema: InvoiceSchema,
})
