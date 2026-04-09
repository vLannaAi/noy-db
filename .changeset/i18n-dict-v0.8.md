---
"@noy-db/core": minor
---

Add `dictKey` schema descriptor, `DictionaryHandle`, and `i18nText` schema type (v0.8 #81 #82)

- `dictKey(name, keys?)` — descriptor for dictionary-backed enum fields, validated on `put()`
- `DictionaryHandle` — CRUD + `rename()` with cascade-rewrite for `_dict_*` reserved collections
- `i18nText({ languages, required, autoTranslate? })` — descriptor for multi-language prose fields
- `validateI18nTextValue` / `resolveI18nText` / `applyI18nLocale` — validation + locale resolution helpers
- New error classes: `ReservedCollectionNameError`, `DictKeyMissingError`, `DictKeyInUseError`, `MissingTranslationError`, `LocaleNotSpecifiedError`
- `LocaleReadOptions` interface for `get(id, { locale, fallback? })` and `list({ locale, fallback? })`
- Compartment gains `dictionary(name, opts?)`, `setLocale()`, `getLocale()`; collection options gain `i18nFields` and `dictKeyFields`
