# Issue #246 — feat(as-xlsx): @noy-db/as-xlsx — Excel spreadsheet plaintext export with ACL-scoped rows + audit entry

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: high, pilot-1

---

Reported by pilot #1 (2026-04-23). Their explicit driver: *"project 1 want to store to-xsls decrypted file"* — pilots framing conflated `to-*` (encrypted store) with `decrypt-*` (plaintext export). Clarifying pattern captured in `docs/patterns/decrypt-exports.md`.

## Scope

Standalone workspace package `packages/decrypt-xlsx/` implementing the `@noy-db/decrypt-*` family shape. Produces a plaintext XLSX (Excel) spreadsheet from a decrypted noy-db collection. Runs in browser or Node — generates bytes, caller decides where the bytes go.

## Proposed API

```ts
import { decryptToXLSX } from "@noy-db/decrypt-xlsx"

// Minimum — single collection
const bytes: Uint8Array = await decryptToXLSX(vault, "invoices")

// Structured — multiple sheets, field selection, label resolution
const bytes = await decryptToXLSX(vault, {
  sheets: [
    {
      name: "Invoices",
      collection: "invoices",
      fields: ["id", "clientName", "amount", "status", "issueDate"],
      // For dictKey fields, resolve labels rather than keys
      resolveDictKeys: true,
      // For i18nText fields, pick a locale
      locale: "th",
    },
    { name: "Payments", collection: "payments" },
  ],
  acknowledgeRisks: true,   // required for long-term storage destinations
  metadata: {                // shown in Excel`s Document Properties
    title: "Q1 2026 Invoices",
    author: "somchai@firm.example",
  },
})

// Caller writes the bytes — browser download, fs.writeFile, S3 upload, etc.
```

## Implementation

- Peer dep on `xlsx` (SheetJS, MIT-licensed, already the de-facto Excel library). Optional alt: `exceljs` for richer formatting — decision during implementation.
- Uses the existing `collection.list()` / `exportStream()` to get decrypted records; NEVER touches the `NoydbStore` layer directly (plaintext only).
- ACL-scoped automatically — invokes `list()` under the callers keyring; operators/clients only export what they have `ro` access to.
- Writes a ledger entry per export: `{ type: "decrypt-export", package: "@noy-db/decrypt-xlsx", collection, recordCount, actor, mechanism: "xlsx", timestamp }` — no record contents, no content hashes (matches `plaintextTranslator` discipline).
- Package README starts with a warning block: *"This package writes plaintext bytes to disk on your behalf. Read docs/patterns/decrypt-exports.md before shipping."*

## Acceptance

1. `decryptToXLSX(vault, "invoices")` produces a valid XLSX that opens in Excel / LibreOffice / Numbers.
2. Thai + Arabic + English strings round-trip (Unicode, not locale-aware).
3. `dictKey` fields with `resolveDictKeys: true` render labels; without, render stable keys.
4. `i18nText` fields with `locale: "th"` render the Thai value; fallback chain if missing.
5. Operator role export scope honoured — requesting a collection without `ro` throws `NoAccessError`, doesnʼt silently return empty rows.
6. Ledger entry written; verifiable by the showcase.
7. Showcase demonstrates all of the above: `showcases/src/16-decrypt-xlsx.showcase.test.ts` (file in v0.19 playground expansion).
8. README warning block present + mandatory-read link to `docs/patterns/decrypt-exports.md`.

## Size

~1.5 days. SheetJS integration is straightforward; the noy-db-specific bits are the ACL gating and the ledger entry. Companion showcase is ~200 LoC.

## Cross-references

- Pattern doc `docs/patterns/decrypt-exports.md` (shipped this session) — the authoritative policy + today-pattern for the pilot.
- Siblings in this fork: #107 decrypt-sql, + decrypt-csv / decrypt-xml (also filed this session).
- SPEC.md §"What zero-knowledge does and does not promise" — the authoritative policy source.
