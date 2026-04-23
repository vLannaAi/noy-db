# Issue #250 — feat(as-json): @noy-db/as-json — structured JSON export with audit gate + browser/node helpers

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, area: core

---

## `@noy-db/as-json` — structured JSON plaintext export

Sibling to the core `exportJSON()` helper — same JSON shape, but shipped as a dedicated `as-*` package so it inherits the Fork · As authorization model (owner-granted `canExportPlaintext`, optional JIT re-auth, audit-ledger entry).

**Why split from core `exportJSON()`?**

`exportJSON()` is five lines, zero deps, and will stay in core for runtime-memory use cases. `as-json` adds:

1. **Authorization gate** — honours `canExportPlaintext` capability (blocked by #249 RFC).
2. **Audit-ledger entry** — automatic `type: 'as-export'` record on every invocation.
3. **Browser-download helper** — wraps the result in a Blob + triggers the download prompt (Tier 2 pattern from `docs/patterns/as-exports.md`).
4. **Node file-write helper** — writes to path with `acknowledgeRisks: true` required for Tier 3.
5. **Schema-aware output** — one file per collection, each with a header object describing the Standard Schema (types, required fields, dictKey references) so downstream consumers can rehydrate.

## API sketch

```ts
import { asJSON } from '@noy-db/as-json'

// Browser download
await asJSON.download(vault, {
  filename: 'vault-export.json',
  collections: ['invoices', 'payments'],   // optional, default all ACL-allowed
  resolveDictionaryLabels: 'en',           // optional, default stable keys
})

// Node file write
await asJSON.write(vault, '/tmp/export.json', {
  acknowledgeRisks: true,  // required for disk writes (Tier 3)
})

// In-memory string
const json = await asJSON.toString(vault)
```

## Output shape

```json
{
  "_noydb": "as-json@0.1",
  "exportedAt": "2026-04-23T10:45:00Z",
  "exportedBy": "somchai@firm.example",
  "collections": {
    "invoices": {
      "schema": { "id": "string", "clientId": "ref:clients", "amount": "number", "status": "dictKey:status" },
      "dictionaries": { "status": { "paid": "Paid", "draft": "Draft" } },
      "records": [ { "id": "01H...", "clientId": "01H...", "amount": 1500, "status": "paid" } ]
    }
  }
}
```

## Acceptance

- [ ] Package skeleton under `packages/as-json/`
- [ ] Three entry points: `download()` (browser), `write()` (node), `toString()`
- [ ] Honours `canExportPlaintext` capability (blocked by #249)
- [ ] Writes audit-ledger entry
- [ ] ACL-scoped (operator without `payments` read can't include it)
- [ ] Unit tests: browser flow, node flow, in-memory flow, authorization refusal, session-policy refusal
- [ ] Showcase demonstrating multi-collection export
- [ ] README with plaintext-on-disk warning block

Blocked by #249 for non-trivial enforcement.
