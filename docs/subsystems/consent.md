# consent

> **Subpath:** `@noy-db/hub/consent`
> **Factory:** `withConsent()`
> **Cluster:** D — Time & Audit
> **LOC cost:** ~194 (off-bundle when not opted in)

## What it does

GDPR/PIPL-style consent audit: scoped reads/writes/deletes inside a `vault.withConsent({ purpose, consentHash }, async () => { ... })` block append one entry per op to `_consent_audit`. Outside the scope, no entries are written. The audit log is queryable via `vault.consentAudit({ purpose, since, ... })`.

## When you need it

- Compliance regimes that require provable consent for personal-data processing
- Per-purpose access logging (researcher queries vs operator queries)
- Subject-access requests ("show me everything that was done with my data and why")

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withConsent } from '@noy-db/hub/consent'

const db = await createNoydb({
  store: ...,
  user: ...,
  consentStrategy: withConsent(),
})
```

## API

```ts
await vault.withConsent(
  { purpose: 'quarterly-review', consentHash: '7f3a...' },
  async () => {
    const invoices = await vault.collection<Invoice>('invoices').list()
    return invoices
  },
)

const log = await vault.consentAudit({ purpose: 'quarterly-review' })
```

## Behavior when NOT opted in

- Every op is silently unaudited — `withConsent` body still runs but no entries are written
- `vault.consentAudit()` returns `[]`

## Pairs well with

- **history** — both append to vault-wide audit primitives
- **periods** — period-bounded queries can carry consent context

## Edge cases & limits

- Consent scope is single-slot per Vault instance. Two concurrent `withConsent` calls stomp each other. Use separate Vault instances or an external `AsyncLocalStorage` shim for per-flight scoping
- The `consentHash` is opaque to NOYDB — pilots typically hash a reference to a signed consent record stored externally

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/consent.test.ts`
