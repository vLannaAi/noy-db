# Issue #248 — feat(as-xml): @noy-db/as-xml — XML plaintext export for legacy systems + accounting software

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: low

---

XML sibling in the `@noy-db/decrypt-*` family. Use cases: legacy systems, Thai accounting software (some require XML), banking batch imports, SOAP endpoints, Excel `.xml` spreadsheetML legacy format.

## API

```ts
import { decryptToXML } from "@noy-db/decrypt-xml"

const xml: string = await decryptToXML(vault, "invoices", {
  rootElement: "Invoices",
  recordElement: "Invoice",
  fields: ["id", "clientName", "amount", "status", "issueDate"],
  pretty: true,
  xmlDeclaration: true,
  namespace: "http://schemas.example.com/accounting/v1",
})
```

## Implementation

Hand-rolled XML emitter (~200–300 LoC, zero deps). Escapes `<`, `>`, `&`, `"`, `\^@-\^_`. Supports custom element names, attributes, namespaces, optional XSD hints.

## Cross-refs

Same discipline as siblings: ACL-scoped, ledger entry, README warning, pattern doc `docs/patterns/decrypt-exports.md`.
