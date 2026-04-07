---
"@noy-db/core": minor
---

Add foreign-key references via `ref()` — soft FK enforcement at the collection level. Three modes:

- **`strict`** (default): `put()` rejects records whose target id doesn't exist; `delete()` of the target rejects if any strict-referencing records still exist. Matches SQL's default FK semantics.
- **`warn`**: both operations succeed unconditionally; broken references surface only through `compartment.checkIntegrity()`.
- **`cascade`**: `put()` is same as warn; `delete()` of the target propagates to delete every referencing record. Cycles are detected and broken via an in-progress set so mutual cascades terminate.

```ts
import { ref } from '@noy-db/core'

const company = await db.openCompartment('demo-co')
const clients = company.collection<Client>('clients')

const invoices = company.collection<Invoice>('invoices', {
  refs: {
    clientId: ref('clients'),               // strict (default)
    categoryId: ref('categories', 'warn'),
    parentId: ref('invoices', 'cascade'),   // self-reference OK
  },
})

await invoices.put('inv-1', { id: 'inv-1', clientId: 'c-1', /* ... */ })
//   → throws RefIntegrityError if 'c-1' doesn't exist in 'clients'

await clients.delete('c-1')
//   → throws RefIntegrityError if any strict-referencing invoices still exist

const { violations } = await company.checkIntegrity()
//   → reports every broken reference, with mode + collection + field metadata
```

New exports from `@noy-db/core`:
- `ref(target, mode?)` helper
- `RefRegistry` class
- `RefIntegrityError`, `RefScopeError`
- Types: `RefMode`, `RefDescriptor`, `RefViolation`
- New method: `Compartment.checkIntegrity()`

What's NOT in this PR:
- Cross-compartment refs (rejected with `RefScopeError` at construction — tracked for v0.5)
- Dotted-path field names (top-level fields only for v0.4)
- `set null` on cascade — only `delete` cascade is implemented

Closes #45, part of #41.
