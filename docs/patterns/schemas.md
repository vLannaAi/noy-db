# Schemas are userland

noy-db is **schema-agnostic**. The hub enforces an encryption invariant
(ciphertext at rest, per-user keyring) and a query contract
(`Collection<T>` with `put` / `get` / `list` / `query`), but it has no
opinion on what `T` *means* — Thai Revenue Department CII, EU Peppol
UBL, US IRS 1099, HIPAA CCDA, HL7, any of it. That's deliberate.

---

## The extension point — Standard Schema v1

Any validator that implements the
[Standard Schema v1](https://standardschema.dev) protocol slots into a
Collection directly:

```ts
import { z } from 'zod'

const InvoiceSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  issuedAt: z.string().datetime(),
  // …
})

vault.collection<z.infer<typeof InvoiceSchema>>('invoices', {
  schema: InvoiceSchema,
})
```

Works identically with Valibot, ArkType, Effect Schema, or a
hand-rolled `{ '~standard': { validate: … } }` object. noy-db validates
on `put()` before encryption and on `get()` after decryption.

---

## Why we don't ship domain schemas under `@noy-db/`

Every market has a regulated invoice format, a jurisdiction-specific
identifier layout, an accounting cadence. Publishing even one under the
`@noy-db/` scope would commit the core to:

- Tracking that standard's revisions (typically every 24–36 months).
- Handling regulator interpretation changes.
- Fielding bug reports that are really domain questions, not crypto /
  store questions.
- A growing tail of *every other* standard anyone asks for next.

Schema-agnostic is the only policy that scales. Domain libraries
belong to domain communities.

---

## Recommended naming convention for community schema packages

If you ship a schema preset and want discoverable naming that
telegraphs compatibility, we suggest:

```
@<your-scope>/noy-db-schema-<format-slug>
```

Examples:

- `@thai-accounting/noy-db-schema-etda-cii`
- `@eu-b2b/noy-db-schema-peppol-ubl`
- `@clinics-uk/noy-db-schema-hl7-fhir`

The convention is a suggestion, not a requirement. noy-db does not
own the name, register the npm prefix, or audit the publish.

---

## Where to list community schemas

If you've shipped a well-maintained schema package you'd like
surfaced from noy-db's docs, open a PR against this file adding a
row below:

| Standard | Package | Maintainer |
|---|---|---|
| *(no community schemas listed yet — be first!)* | | |

Criteria for listing:

- Implements Standard Schema v1
- Has a test suite that validates against the standard's official
  reference instances (XSDs, JSON Schemas, etc.)
- Maintains a CHANGELOG + semver discipline
- Responds to the standard's update cadence

Listing here is a lightweight acknowledgement, not an endorsement —
noy-db takes no position on correctness, legal compliance, or fitness
for any regulated deployment. Use at your own risk, audit before
production.
