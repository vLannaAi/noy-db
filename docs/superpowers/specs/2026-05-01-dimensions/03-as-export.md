# Dimension 03 — Portable-artefact exports (`as-*`)

## Purpose

Cover the long tail of business-interchange formats people actually need to hand off data to other systems, regulators, customers, accountants, or themselves. Plaintext and ciphertext exports both qualify; the two-tier authorisation model already in place (`canExportPlaintext` / `canExportBundle`) extends to every new format.

## Current state

9 packages: `as-csv`, `as-xlsx`, `as-json`, `as-ndjson`, `as-xml`, `as-sql`, `as-blob`, `as-zip` (with WinZip-AES-256), `as-noydb` (encrypted bundle). Phase 1+2 import readers shipped (`fromString`/`fromBytes`, `ImportPlan`, `apply()` inside transactions, capability gate).

## Target state

The matrix of formats expands to cover:
- **Printable / shareable artefacts** (PDF, HTML, Markdown)
- **Analytical interchange** (Parquet, Arrow)
- **B2B / regulatory** (EDI X12, EDIFACT, ISO 20022, FATCA/CRS)
- **Office productivity** (DOCX, ODT)
- **Personal information management** (vCard, iCalendar)

Symmetric `fromBytes`/`fromString` readers exist where the format permits (PDF read is hard; vCard/iCal read is easy). Two-tier authorisation extends to every format.

## Concrete additions

**Print and share:**
- `as-pdf` — printable reports with templating, page breaks, headers; plaintext-tier
- `as-html` — mailable / archivable; plaintext-tier; reader optional
- `as-md` — Markdown for knowledge-base portability; plaintext-tier; symmetric reader

**Analytical:**
- `as-parquet` — columnar; plaintext-tier; reader for re-import
- `as-arrow` — in-process zero-copy; plaintext-tier; primarily for `in-ai` / `in-tanstack-query` consumers

**B2B / cross-border (high mission alignment):**
- `as-edi-x12` — North American EDI; plaintext-tier; per-transaction-set mapping
- `as-edifact` — EU/global EDI; plaintext-tier; same shape as `as-edi-x12`
- `as-iso20022` — financial messaging (cross-border payments — directly serves the "merging countries and markets" brief); plaintext-tier; reader essential
- `as-fatca-crs` — tax-compliance schemas; plaintext-tier; export-only

**Office:**
- `as-docx` — Word; plaintext-tier; templated
- `as-odt` — OpenDocument; plaintext-tier; templated

**PIM:**
- `as-vcard` — contacts; plaintext-tier; symmetric reader
- `as-icalendar` — calendar; plaintext-tier; symmetric reader

## Non-goals & tradeoffs

- **Re-implementing full Office write paths.** Use existing OSS libraries where possible; templates only, not full layout fidelity.
- **PDF reader.** Extracting structured records from arbitrary PDFs is OCR territory — out of scope. PDF write only.
- **Lossy round-trips.** If `from*` cannot reproduce the source vault to a round-trippable level, the format is export-only and documents the asymmetry.
- **Format-specific encryption.** Only `as-zip` (WinZip-AES) and `as-noydb` (envelope-format) carry encryption. Others are plaintext exports gated by `canExportPlaintext`.

## Dependencies / sequencing

- ImportPlan symmetry contract is locked (already at v0.6) — new readers must conform.
- `vault.assertCanImport(tier, format?)` extends per-format; default-closed for new formats.
- Bundle-size CI gate accommodates per-format optional deps (lazy-load big libraries — `pdfkit`, `apache-arrow`).

## Cross-references

- `features.yaml` → `exports`
- Related: Dimension 07 (computed fields might land in printable templates), Dimension 04 (`in-rest` exposes some exports as endpoints), Dimension 12 (rolling NDJSON / Parquet / CSV-rolling for streams), Dimension 13 (Parquet / Arrow for embeddings), Dimension 14 (do exports include derived data, or only primaries? — open question added)
- Spec anchor: `SUBSYSTEMS.md#portable-artefact-exports`

## Open questions

- **Which exports get `fromBytes` readers?** PDF probably never; ISO 20022 probably yes; DOCX text-only round-trip?
- **Internationalisation in templates.** `as-pdf` / `as-docx` need locale-aware templates — couples to the existing `i18n` subsystem.
- **Granular auth on export.** Should `canExportPlaintext` be format-keyed (`['csv', 'pdf']`) or category-keyed (`['printable', 'analytical', 'b2b']`)?
- **Streaming exports.** `as-parquet` and `as-pdf` (large reports) want streaming; the current writer shape is buffered. Does that need a contract change?
