# Internationalization — i18n via-feature

Declares translatable text fields with automatic locale-aware lookup and presentation. `i18nText({ dict: 'labels' })` means a field reads from a named dictionary; writes auto-fill missing translations where possible, and reads present a `Label` virtual field with the value resolved to the current locale.

## Declaration

Use the `via()` composer with `i18nText()`:

```ts
collection<Product>({
  schema: {
    name: via(i18nText({ dict: 'productNames' })),
    description: via(i18nText({ dict: 'productDescriptions' }))
  }
})
```

Or use static inline dictionaries:

```ts
collection<Status>({
  schema: {
    code: via(staticDict({ pending: 'Pending', completed: 'Completed' }))
  }
})
```

Or the older declarative i18n spellings (still work, identical internals):

```ts
collection<Product>({
  i18nFields: { 
    name: { dict: 'productNames' },
    description: { dict: 'productDescriptions' }
  }
})
```

All spellings produce identical stored envelopes and identical `describe()` output.

## Virtuals & locale resolution

Reading an i18n field unpacks a read-time virtual for convenience: `<field>Label` provides the translated text for the current locale:

```ts
const product = await collection.first()
// product.name        → { en: 'Widget', de: 'Dings', ... }  (underlying storage)
// product.nameLabel   → 'Widget'  (resolved to current locale)
```

## Dictionary management

Dictionaries are stored in a collection-scoped `_dicts` envelope and managed via `vault.dictionary(name)`. Static dictionaries are inlined at declaration time and do not require external storage.

## Query & search

`where()` predicates on i18n fields query against all locale versions. Locale-specific matching is available through explicit field navigation.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- `@noy-db/hub/shape/via-i18n` — the binding and engine
