---
"@noy-db/core": minor
---

v0.8 i18n completion: plaintextTranslator hook (#83), exportStream dictionary snapshot (#84), query DSL dictKey integration (#85).

- **plaintextTranslator (#83)**: Consumer-supplied async translation function for `i18nText` fields with `autoTranslate: true`. Runs before i18n validation in `put()`. In-process content-hash cache cleared on `close()`. Audit log via `db.translatorAuditLog()` with cache-hit flag. `TranslatorNotConfiguredError` when translator missing.
- **exportStream dictionary snapshot (#84)**: `exportStream()` attaches a `dictionaries` field to chunks from collections with dictKey fields. Snapshot is captured atomically before the first yield — concurrent mutations do not affect it. `exportJSON()` embeds `_dictionaries` at top level; omits it when `resolveLabels` is set.
- **Query DSL dictKey integration (#85)**: `query().join(field)` resolves dictKey fields as dict joins, attaching `{ key, ...labels }` under the given alias. `groupBy(field).aggregate(...).runAsync({ locale })` adds `<field>Label` to grouped result rows. Stable keys used for grouping regardless of locale. `DictionaryHandle` maintains a write-through sync cache for O(1) snapshot access inside the query executor.
