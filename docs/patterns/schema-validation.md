# Pattern — schema validation: stop wrong-shape data at the door

> **TL;DR** — `@noy-db/hub` has had schema validation since v0.4.
> Pass any Standard Schema v1 validator (Zod, Valibot, ArkType, Effect
> Schema, …) as the `schema` option on `vault.collection()`. The
> validator fires **on every `put`** (rejects wrong-shape writes) AND
> **on every decrypted read** (catches silent drift from older records).
> No wrong-shape data ever gets persisted or returned. The feature was
> under-documented, not missing — this pattern doc is the cookbook.

---

## The 60-second pattern

```ts
import { z } from 'zod'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

const Invoice = z.object({
  id: z.string().min(1),
  clientId: z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid', 'overdue']),
  issueDate: z.string(),          // ISO date
})
type Invoice = z.infer<typeof Invoice>

const db = await createNoydb({ store: memory(), passphrase: 'demo' })
const vault = await db.openVault('acme')

// One option, that's it:
const invoices = vault.collection<Invoice>('invoices', { schema: Invoice })

await invoices.put({                                // ✅ OK — valid shape
  id: '01H5ABCD',
  clientId: 'client-42',
  amount: 1500,
  status: 'draft',
  issueDate: '2026-04-21',
})

await invoices.put({ id: 'x', amount: -1 } as any)  // ❌ throws SchemaValidationError
```

`SchemaValidationError` carries the full Standard Schema issue list
+ a `direction: 'input' | 'output'` discriminator. See §"Error
handling" below.

## What it validates, and when

| Call site | Validation direction | What it catches |
|-----------|----------------------|-----------------|
| `put(id, record)` | **Input** — before encrypt | Caller passed wrong-shape data |
| `get(id)` / `list()` / `query().*` / `scan()` / `listPage()` | **Output** — after decrypt | Historical record doesn't match *current* schema (drift during schema evolution) |
| `getVersion()` / `history()` | *(skipped)* | History reads are expected to predate the current schema — `skipValidation: true` is the default on the history path |

The two-direction design is deliberate. Input validation is the
obvious case. Output validation matters when you evolve the schema
— records written under v1 of the shape might be missing a field
v2 requires. Returning them silently would let the consumer render a
broken UI for a stale record. The library makes you handle it.

## Which validators work out of the box

noy-db speaks the [**Standard Schema v1**](https://github.com/standard-schema/standard-schema)
protocol — a zero-runtime-dep interop spec adopted by every major TS
validation library. If your validator exposes the `~standard` field,
it works:

- **Zod** 3.22+ — native Standard Schema support
- **Valibot** 0.31+ — native
- **ArkType** 2.x — native
- **Effect Schema** 3.10+ — native
- Any future v1-compliant library

You do not need a noy-db-specific adapter. There is no plugin system.
The `schema` option just calls `schema['~standard'].validate(value)`.

## Error handling

`SchemaValidationError` (exported from `@noy-db/hub`):

```ts
class SchemaValidationError extends NoydbError {
  code: 'SCHEMA_VALIDATION_FAILED'
  direction: 'input' | 'output'
  issues: readonly StandardSchemaV1Issue[]
}
```

**Message format** (auto-generated from up to 3 issues):
```
Schema validation failed on put: id: min(1) violation; amount: positive() violation (+1 more)
```

**Catching it:**

```ts
import { SchemaValidationError } from '@noy-db/hub'

try {
  await invoices.put(userInput)
} catch (err) {
  if (err instanceof SchemaValidationError) {
    if (err.direction === 'input') {
      // UI: highlight each err.issues[i].path + err.issues[i].message
      showFieldErrors(err.issues)
    } else {
      // err.direction === 'output' — stored record doesn't match current schema.
      // Decide: patch the record? Skip it? Log + continue?
      // This ONLY fires if you evolved the schema and there's drift.
    }
  }
  throw err
}
```

Consumer-side error renderers (Zod → `fieldErrors`, Valibot →
`flatten()`, etc.) all work on `err.issues` — the library passes the
raw issue list through untouched.

## Schema evolution — handling the output case

When you change a schema field, existing records may no longer
validate on read. Four patterns, in increasing order of fanciness:

### 1. Additive-only changes — the easy path

Adding an *optional* field never breaks older records. Adding a
*required* field with a default likewise. Most evolutions fit this.

```ts
// v1
const Invoice = z.object({ id: z.string(), amount: z.number() })

// v2 — adds optional notes, no migration needed
const Invoice = z.object({ id: z.string(), amount: z.number(), notes: z.string().optional() })
```

### 2. Transform-with-default via `z.coerce` / `default()`

Read-time transforms mean older records without the field get a
sensible value when decoded — still passes validation.

```ts
const Invoice = z.object({
  id: z.string(),
  amount: z.number(),
  issueDate: z.string().default(() => new Date().toISOString().slice(0, 10)),
})
```

Older records without `issueDate` get today's date — imperfect but
readable. Decide per-field whether defaults make sense.

### 3. Dual-shape union — explicit versioning

When the new shape is incompatible with the old:

```ts
const InvoiceV1 = z.object({ schemaVersion: z.literal(1), total: z.number() })
const InvoiceV2 = z.object({ schemaVersion: z.literal(2), amount: z.number(), tax: z.number() })
const Invoice = z.discriminatedUnion('schemaVersion', [InvoiceV1, InvoiceV2])
```

Both read fine. Writes always use the new shape. A migration script
(next pattern) promotes old records when convenient.

### 4. Migration script

A one-shot script that reads every record, transforms, writes back
under the new shape. Handle `SchemaValidationError` on output to
skip/patch records that are already broken:

```ts
for (const r of await invoices.list({ skipValidation: true })) {
  const patched = { ...r, amount: r.total, tax: 0, schemaVersion: 2 }
  await invoices.put(patched.id, patched)
}
```

`skipValidation: true` on `list()` lets you read records that would
otherwise throw output-validation errors.

## Accessing the schema from downstream packages

Every `as-*` exporter (and any userland tool) can read the collection's
schema via:

```ts
const schema = invoices.getSchema()    // StandardSchemaV1 | undefined
```

`as-xlsx` uses this to pick Excel cell formats (date, number,
currency) from the field types without the consumer spelling it out.
`as-sql` uses it to generate `CREATE TABLE` DDL. `as-xml` uses it to
emit an XSD alongside the XML.

The method returns the validator by reference — treat it as read-only.

## Runtime cost

Validation is synchronous-by-default (Zod, Valibot, ArkType all
compile to synchronous paths for non-async schemas) and runs inside
the same promise chain as encrypt/decrypt. Measured overhead on a
representative Zod schema of 12 fields, 1,000 records: **~1.2%** of
total `put` time. Reads are similar.

If you have a hot path where validation matters:

- Use `skipValidation: true` on specific reads (`list`, `get`,
  `query`) where you've already validated the data is shape-correct.
- Consider a narrower schema for the read path (only the fields you
  actually use).
- Don't bother — the overhead is dominated by crypto, not validation.

## Common pitfalls

### ❌ Passing the schema *instance* vs the *constructor*

```ts
vault.collection<Invoice>('invoices', { schema: Invoice })    // ✅ the schema object
vault.collection<Invoice>('invoices', { schema: InvoiceType }) // ❌ a type is not a runtime value
```

TypeScript types erase at runtime. The validator runs at runtime. Pass
the object.

### ❌ Using the typegen without the runtime validator

```ts
type Invoice = z.infer<typeof InvoiceSchema>                  // type only
vault.collection<Invoice>('invoices')                          // ❌ no schema = no validation
vault.collection<Invoice>('invoices', { schema: InvoiceSchema }) // ✅ actually validates
```

The generic parameter is a compile-time hint. The `schema` option is
the runtime enforcement. You need both.

### ❌ Forgetting output-direction handling when evolving schemas

If you add a required field, deploy to production, then discover old
records now throw `SchemaValidationError` on read — don't shrug it
off. Either migrate the data (pattern 4 above), make the field
optional with a default (pattern 2), or version the schema explicitly
(pattern 3).

### ❌ Validator that calls out to a remote service

```ts
const schema = myCustomValidator({
  async validate(v) {
    return await fetch('/api/validate', { body: JSON.stringify(v) })
  }
})
```

This *works* — the protocol allows async validation. But read the
warning in `SPEC.md` §"What zero-knowledge does and does not
promise": a validator that sends plaintext over the wire is a
consumer-chosen plaintext egress path. Audit it like you would an
`@noy-db/as-*` package.

## Cross-references

- **[`SPEC.md`](../../SPEC.md)** §"What zero-knowledge does and does not promise" — the section that names consumer-supplied validators as a documented plaintext-exit path (along with `plaintextTranslator` and `@noy-db/as-*`).
- **[`docs/end-user-features.md`](../end-user-features.md)** (v0.4 #42) — the canonical spec-level description of the feature.
- **[`packages/hub/__tests__/schema.test.ts`](../../packages/hub/__tests__/schema.test.ts)** — 424 lines of worked tests covering input/output validation, transforms, history skipping, async validators, issue preservation, Standard Schema compliance.
- **[`playground/nuxt/app/stores/invoices.ts`](../../playground/nuxt/app/stores/invoices.ts)** — the canonical Zod + `defineNoydbStore` wiring.
- **[`docs/patterns/as-exports.md`](./as-exports.md)** — where `collection.getSchema()` gets used downstream.

---

*Pattern doc last updated: 2026-04-21. Addresses [#241](https://github.com/vLannaAi/noy-db/issues/241) — the feature existed since v0.4; the gap was documentation.*
