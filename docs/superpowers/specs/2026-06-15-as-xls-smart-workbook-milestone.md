# `as-xls` — smart workbook milestone (evolving `@noy-db/as-xlsx`)

- **Date:** 2026-06-15
- **Status:** Design / proposed milestone
- **Family:** `as-*` (projection/export) — **evolves the existing `@noy-db/as-xlsx`**
- **Codename:** "as-xls" = the *smart-workbook* evolution of `as-xlsx` (not a new package — see §2)

## 1. Vision

Project a noy-db vault **AS a sophisticated, live Excel / Google Sheets workbook** — not a flat data dump, but a relational, computed, localized model where noy-db features map to high-level spreadsheet features:

- multiple collections → multiple sheets (+ a manifest/index sheet)
- foreign keys → cross-sheet `VLOOKUP`/`XLOOKUP`/`INDEX-MATCH` + data-validation
- dictionaries (code tables) → hidden lookup sheets + **data-validation dropdowns** ("dataset for popup") + label formulas
- i18n fields → hidden per-locale columns + a resolved display column
- **a single global "language" cell that re-renders the entire workbook's labels live** (the headline feature)
- derivations → live formulas where translatable, static+audited otherwise
- groupBy / materialized views → live aggregation (SUMIFS, or Sheets `QUERY`) on dedicated sheets
- rollups → normalized detail sheets + subtotal formulas
- money → currency cell formats over a faithfully-stored value
- cell formatting, frozen headers, auto-filter

…plus a **Read path**: import a workbook either onto an **existing** noy-db schema, or **infer a new** schema mirroring the workbook.

## 2. Reframe: this is an evolution, not greenfield

`@noy-db/as-xlsx` **already exists** (v0.2.0-pre.18):

- **Export:** `toBytes` / `toBytesFromCollection` / `download` / `write` — produce a **flat, value-only** workbook (one sheet per collection, dict-label expansion).
- **Import:** `fromBytes` → `AsXlsxImportPlan` with `ImportPolicy` (`merge`/`replace`/`insert-only`) + dict inversion (`XlsxDictAmbiguityError`); `read.ts` is a from-scratch XLSX reader.
- **Writer:** `xlsx.ts` hand-rolls OOXML (via `fast-xml-parser`, **no exceljs/sheetjs**) and explicitly does **not** emit formulas, named ranges, merged cells, frozen panes, or data validation.

So the milestone = **upgrade `as-xlsx` from "value dump" to "smart workbook."** **Decision: keep the package name `@noy-db/as-xlsx`** (already published; `as-*` = export *format*, and the format is xlsx). "as-xls" is the milestone codename / a `mode: 'smart'` option — we do **not** ship a near-duplicate `as-xls` package.

## 3. The pivotal constraint — the hand-rolled OOXML writer

The biggest engineering reality: there is no exceljs/sheetjs. Extending `xlsx.ts` is required for every "smart" feature.

- **Tractable XML additions:** `<f>` formulas, `<definedName>` (named ranges), `<dataValidation>`, hidden columns, number formats, frozen panes, auto-filter.
- **Hard / avoid:** **PivotTables** (separate `pivotCache` + `pivotTable` OOXML parts — gnarly). We therefore realize groupBy/MV with **formulas (SUMIFS)** instead of pivots.
- **Correctness trap:** `QUERY()` is a **Google-Sheets-only** function — it **errors in Excel**. Therefore the cross-compatible default is formula primitives (`VLOOKUP`/`INDEX`/`MATCH`/`SUMIFS`/`IFERROR` + named ranges + data validation) emitted into `.xlsx`, which **both** Excel and Sheets honor. Sheets-native `QUERY`/pivots become a **separate later target via the Google Sheets API** (the Workspace MCP), not via the .xlsx writer.

## 4. Export feature map (synthesized)

| noy-db concept | Excel + Sheets construct (cross-compatible) | Live? | Round-trip |
|---|---|---|---|
| Vault → Workbook; Collection → Sheet | one sheet per collection + `_manifest` sheet | n/a | structural |
| Schema → typed columns | header row; number-format per scalar type; nested → dotted columns; arrays → JSON or junction | n/a | high w/ schema |
| Record id / `_v` / `_ts` | visible `id` col (round-trip key) + hidden `_v`/`_ts` cols | n/a | enables OCC on import |
| Money | currency number-format over faithfully-stored decimal; multi-currency → `amount`+`currency` cols | n/a | high (quantize on write) |
| FK (`ref`) | `=IFERROR(VLOOKUP(code, other!$A:$Z, MATCH(...),0),"")` + data-validation list against target id range | live | code col is source of truth |
| `refArray` / `vault.link` | dedicated junction sheet `_links_<name>` (a, b, meta…) | n/a | high |
| Dictionary (`dictKey`/`staticDict`) | hidden `_Lookups_<dict>` (code, Label_<locale>…) + **data-validation dropdown** on code cell + label via `VLOOKUP(code,…,MATCH(LANG,…))` | live | code is source; labels regenerated |
| i18n text field | hidden per-locale cols (`name_en`,`name_th`,…) + display col `=INDEX(locales, MATCH(LANG, headers,0))` | live | all locale cols re-import |
| **Global language cell** | Settings sheet `LANG` named range + dropdown; every label/i18n cell references it (see §5) | live | informational on import |
| Derivation (translatable) | direct formula (`=CEILING(LEN(body)/1000)`, `=a&b`, `=IF(...)`) | live | re-compute on import |
| Derivation (opaque JS / cross-record) | static value + audit note ("snapshot @ ts") on a Derivation-Audit sheet | static | re-compute on import |
| groupBy / query-form MV | `SUMIFS`/`COUNTIFS`/`AVERAGEIFS` on a dedicated MV sheet (Excel+Sheets); optional Sheets-native `QUERY` later | live | one-way (or re-materialize) |
| union-form MV | static snapshot, or Sheets `{rangeA;rangeB}`+`QUERY` (Sheets-only, later) | static/live | one-way |
| `withRollup` | normalized `<parent>_rollup` sheet + `SUMIF` back-reference (avoids sparse wide cols) | live | re-compute on import |
| Sequences (formatted) | static values + metadata (format, last serial, partition) for `seedTo` on import | static | preserve or re-seed |
| Formatting/locale number formats | per-export format locale (cell number-format is a property, **not** formula-driven by `LANG`) — documented limitation | static | n/a |

## 5. Headline feature — the global language cell

A **Settings** sheet holds a single `LANG` cell (named range `LANG`, data-validation dropdown of available locales). Every dictionary-label and i18n display cell resolves its text by referencing `LANG`:

- **dict label cell:** `=IFERROR(VLOOKUP(B2, _Lookups_status!$A$2:$D$9, MATCH(LANG, _Lookups_status!$A$1:$D$1, 0), FALSE), B2)`
- **i18n display cell:** `=IFERROR(INDEX(B2:D2, MATCH(LANG, Headers!$B$1:$D$1, 0)), B2)`

Changing `LANG` from `en` → `th` re-renders **the entire workbook's labels live** (Excel and Sheets both auto-recalc). Stored codes/values never change.

**Documented limitations:** (1) `LANG` drives *text*, not *number/date formats* (cell formats are properties, not formulas). (2) `LANG` does **not** re-sort rows — label-sort is computed at export time; a Settings note + optional macro/Apps-Script covers re-sort. (3) `smartSubstitute` (script-nearest fallback) is a noy-db read-time refinement that does not translate to a formula; export uses a static fallback chain (`IFERROR` → fallback locale → code).

## 6. Read / import path

- **Mode A — map onto existing schema:** use `vault.dumpSchema()` to discover target fields/types/refs; reverse the export layout — reconstruct i18n maps from per-locale columns, invert dict labels→codes (existing `buildInversionMap`), validate FKs, quantize money. Computed/MV columns: policy `ignore` (default, recompute) / `accept` / `warn`. Reject imports targeting an MV output collection. Bulk write via `putMany(..., { atomic: true })`, id-preserving for true round-trip.
- **Mode B — infer a new schema:** type-infer from cell number-formats + sampled data (currency format → money, date format → date, low-cardinality column → dict/enum, `name_<locale>` columns → i18n, value-subset-of-another-sheet's-ids → FK). Build schema-free collections for the data and **emit a Zod + config guidance snippet** the user adopts (Standard Schema validators aren't JSON-serializable, so we don't fabricate a live validator silently).

**Honest hard problems:** PivotTable OOXML (avoided via SUMIFS); translating arbitrary JS derivations to formulas (only a declarative subset is safe — propose an optional `formulaSpec` alongside `derive`); FK inference ambiguity (≥80%-subset heuristic + user disambiguation); single-locale → multi-locale i18n reversal (opt-in `inferLocaleFromHeaders`); id-column detection (explicit `idKey` override always available).

## 7. Phasing (each phase = its own PR/slice)

- **P1 — Smart structural export:** writer gains formulas/named-ranges/data-validation/hidden-cols/number-formats; `_manifest`; typed columns; money formats; FK `VLOOKUP` + data-validation; junction sheets; hidden `id`/`_v`/`_ts`.
- **P2 — Localization:** dict lookup sheets + dropdowns; i18n locale columns; **global `LANG` cell** + Settings sheet.
- **P3 — Computed:** translatable derivations → formulas; groupBy/query-form MV → SUMIFS sheets; rollups → normalized sheets; derivation-audit sheet for opaque ones.
- **P4 — Smart import:** Mode A reverse-mapping (i18n/dict/FK/money) on top of existing `fromBytes`; Mode B schema inference + Zod guidance.
- **P5 — Google Sheets native (optional):** Sheets-API target with `QUERY`/pivots/live MV via Workspace MCP.

## 8. Landing checklist (per the repo conventions)

- `features.yaml` export entry updates (capability `canExportPlaintext`, new invariants, showcase ids).
- `docs/packages/as-exports.md` — expand the `as-xlsx` entry to document smart-workbook mode.
- Showcases under `showcases/src/NN-as-xlsx-*.showcase.test.ts` per phase.
- Architecture check: kernel-surface untouched (this is package-local); ensure `as-xlsx` stays plaintext-tier gated (`canExportPlaintext`) + re-auth where required.

## 9. Open strategic decisions

1. **Default mode:** keep flat `as-xlsx` behavior as default and gate smart features behind `mode: 'smart'`, or make smart the default with `mode: 'flat'` escape hatch?
2. **Live vs snapshot default** for computed/MV: formulas (live, can drift from noy-db semantics) vs static (faithful snapshot)?
3. **Excel-first vs Sheets-first** for the live-aggregation story (SUMIFS now, QUERY later — confirm P5 priority).
4. **Declarative `formulaSpec`** on derivations — worth adding to the hub so derivations can advertise a spreadsheet-formula twin?
5. Global-LANG scope: per-workbook only, or also a per-sheet override?
