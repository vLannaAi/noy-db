---
"@noy-db/core": minor
"@noy-db/pinia": minor
---

Add schema validation via Standard Schema v1. Any validator that implements the [Standard Schema v1 protocol](https://standardschema.dev) — Zod, Valibot, ArkType, Effect Schema — can now be attached to a `Collection` or `defineNoydbStore`.

```ts
import { z } from 'zod'

const InvoiceSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid']),
})

// defineNoydbStore — the recommended path
export const useInvoices = defineNoydbStore<z.infer<typeof InvoiceSchema>>('invoices', {
  compartment: 'demo-co',
  schema: InvoiceSchema,
})

// Low-level Collection — also supported
const invoices = company.collection('invoices', { schema: InvoiceSchema })
```

Validation runs **before encryption on `put()`** (bad input throws `SchemaValidationError` with `direction: 'input'`) and **after decryption on reads** (stored data that has drifted from the current schema throws with `direction: 'output'`). The thrown error carries the full Standard Schema issues list so UI code can render field-level messages.

History reads (`getVersion`, `history`) intentionally skip validation — historical records predate the current schema by definition.

New exports from `@noy-db/core`:
- `StandardSchemaV1`, `StandardSchemaV1Issue`, `InferOutput` types
- `validateSchemaInput`, `validateSchemaOutput` helpers
- `SchemaValidationError` class

**Breaking change in `@noy-db/pinia`**: the `schema` option now expects a Standard Schema v1 validator (anything with a `'~standard'` key and `version: 1`) instead of an object with a `.parse()` method. Consumers using Zod directly don't need to change anything — Zod schemas already implement Standard Schema v1. Consumers who passed a hand-rolled `{ parse }` object need to wrap it in the v1 protocol shape (see the updated `playground/nuxt/app/stores/invoices.ts` for an example).

Closes #42, part of #41.
