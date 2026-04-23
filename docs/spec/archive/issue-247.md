# Issue #247 — feat(as-csv): @noy-db/as-csv — CSV plaintext export (simplest of the as-* family)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: low

---

Simplest sibling in the `@noy-db/decrypt-*` family. ~50 LoC. Zero runtime deps — hand-rolled CSV escaping (RFC 4180).

## API

```ts
import { decryptToCSV } from "@noy-db/decrypt-csv"

const csv: string = await decryptToCSV(vault, "invoices", {
  fields: ["id", "clientName", "amount", "status"],
  delimiter: ",",           // default
  lineEnding: "\r\n",       // RFC 4180 — configurable
  includeHeader: true,
  resolveDictKeys: true,
  locale: "en",
})
```

## Why this over xlsx

- **Zero deps** — no SheetJS / exceljs peer dep.
- **Streaming-friendly** — can emit line by line for huge exports.
- **Universal** — every spreadsheet + database tool imports CSV.
- **Human-readable** in a text editor for audit.

## Cross-refs

Same discipline as decrypt-xlsx (#decrypt-xlsx filed this session): ACL-scoped, ledger entry, README warning, pattern doc `docs/patterns/decrypt-exports.md`.
