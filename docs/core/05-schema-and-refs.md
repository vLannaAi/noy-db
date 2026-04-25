# Core 05 — Schema & Refs

> **Always-on. Lightweight typing scaffold.**
> Source of truth: `packages/hub/src/{schema,refs}.ts`

## What it is

Two small features that live in the always-on core:

1. **Schema** — Standard Schema v1 validators (Zod, Valibot, ArkType, Effect Schema, etc.) plug in via `collection({ schema })`. Validates input on `put()` and output on read.
2. **Refs** — Foreign-key style references between collections. Used by joins (today always-core; will become `withJoins()`) and by ref-mode dispatch on parent deletes.

## Schema validation

```ts
import { z } from 'zod'

const InvoiceSchema = z.object({
  id:     z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid', 'overdue']),
  date:   z.string().datetime(),
})

const invoices = vault.collection<z.infer<typeof InvoiceSchema>>('invoices', {
  schema: InvoiceSchema,
})
```

- **Input validation** runs in `put()` *before* encryption. Throws `SchemaValidationError` with `direction: 'input'` and the validator's full issue list.
- **Output validation** runs in `get()` / `list()` / `query()` *after* decryption. Throws with `direction: 'output'` if stored data drifted from the schema (data migration scenarios).

The `T` parameter on `Collection<T>` is the OUTPUT type — whatever the validator produces after coercion / transform.

## Refs

```ts
import { ref } from '@noy-db/hub'

const clients  = vault.collection<Client>('clients')
const invoices = vault.collection<Invoice>('invoices', {
  refs: {
    clientId: ref('clients'),
  },
})
```

Three modes (passed as `ref(target, mode)` or `ref(target, { mode })`):

| Mode | On parent delete | On dangling read |
|---|---|---|
| `'strict'` (default) | Throws `RefIntegrityError` unless cascaded | Throws on join |
| `'warn'` | Throws | Joined value is `null`; one-shot console warn |
| `'cascade'` | Cascades the delete to all referencing children | Joined value is `null` silently |

Used by:
- `query.join(field, { as })` — see [docs/subsystems/joins.md](../subsystems/joins.md)
- `vault.checkIntegrity()` — full ref-graph audit
- `Vault.delete*` enforcement — `enforceRefsOnDelete(collection, id)`

## Edge cases

- Refs are **intra-vault**. Cross-vault references are out of scope; use `db.queryAcross` for federated reads.
- Schema validation is opt-in per collection. Vaults can mix validated and unvalidated collections.
- `put()` schema runs after the i18n validator (when configured), so an i18nText field's locale-map shape is checked before the schema sees the value.

## See also

- [docs/subsystems/joins.md](../subsystems/joins.md)
- [docs/subsystems/i18n.md](../subsystems/i18n.md) — i18nText / dictKey field descriptors layered on top
- [SPEC.md § Schema](../../SPEC.md)
