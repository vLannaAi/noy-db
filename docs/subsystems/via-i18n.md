# Internationalization — i18n via-feature

The i18n via-feature bundles three distinct capabilities that share one binding and one Via
brand (`'i18n'`) but behave differently — don't conflate them:

1. **`i18nText()`** — a multi-language content field. The stored value is a
   `{ [locale]: string }` map; on read, the field is resolved **in place** to the string for the
   active locale (no separate virtual field).
2. **`dictKey()` / `staticDict()`** — a code field (e.g. `status: 'paid'`). The stored value is
   the bare code; on read, a sibling `<field>Label` virtual is added with the resolved display
   label. The field's own value is left as the code.
3. **Dictionaries** — vault-scoped reserved `_dict_<name>` collections, managed via
   `vault.dictionary(name)`, that back `dictKey()` fields with mutable, per-vault key→label
   tables. `staticDict()` fields don't use a dictionary at all — their labels are supplied in
   code.

## `i18nText()` — locale-map fields

Declares a field whose value is a `{ [locale]: string }` map. `languages` declares the full
locale set; `required` (`'all'` | `'any'` | a subset array) controls which locales must be
present on `put()`.

```ts
const vault = await db.openVault('company', { locale: 'en' })  // the read-time default locale
const docs = vault.collection<Doc>('docs', {
  viaFields: {
    name: via(i18nText({ languages: ['th', 'en'], required: 'all' })),
  },
})

await docs.put('c1', { id: 'c1', name: { th: 'สมชาย', en: 'Somchai' } })
const raw = await docs.get('c1', { locale: 'raw' })
// raw.name → { th: 'สมชาย', en: 'Somchai' }  (the full stored map)

const read = await docs.get('c1')  // reads under the vault's active locale ('en')
// read.name → 'Somchai'  (resolved IN PLACE to the locale string — no `nameLabel` virtual)
```

Or the older `i18nFields` sugar spelling (still works, identical internals):

```ts
const docs = vault.collection<Doc>('docs', {
  i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
})
```

Other `i18nText()` options: `autoTranslate`, `onMissing` (per-layer resolution policy),
`substitute` (fallback chain), `smartSubstitute`, `script`/`onScriptViolation` (write-time
script enforcement), and `densifyOnWrite` (eager-fill empty slots from the substitute chain at
write time).

## `dictKey()` / `staticDict()` — code fields with a `<field>Label` virtual

`dictKey(name, keysOrMap?, opts?)` declares a field that stores a stable **code**
(e.g. `'paid'`) and resolves its display label from a named dictionary. `name` is the
dictionary name; `keysOrMap` is either an `as const` array of valid keys, or a
value→label map (keys inferred, labels used as inline `describe()` defaults).

```ts
const vault = await db.openVault('company', { locale: 'th' })  // dict labels need an active locale
await vault.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

const orders = vault.collection<Order>('orders', {
  viaFields: {
    status: via(dictKey('status', ['paid'] as const)),
  },
})

await orders.put('o1', { id: 'o1', status: 'paid' })
const read = await orders.get('o1')
// read.status      → 'paid'          (the code, unchanged)
// read.statusLabel → 'ชำระแล้ว'       (resolved from the dictionary, active-locale label)
```

`staticDict(name, table, opts?)` is a sibling for **closed, code-defined, identical-across-vaults**
enums — no `_dict_*` collection, no `rename()`. `table` is a `{ key: { locale: label } }` map
supplied directly in code:

```ts
const workers = vault.collection<Worker>('workers', {
  viaFields: {
    civilStatus: via(staticDict('civilStatus', {
      adultMale:   { th: 'นาย', en: 'Mr' },
      adultFemale: { th: 'นาง', en: 'Mrs' },
    }, { displayLocale: 'th' })),
  },
})
```

`opts.displayLocale` lets a static dict emit `<field>Label` even under a **locale-less** read —
`dictKey` cannot do this (a locale-less `dictKey` read omits the `Label` virtual).

Both `dictKey` and `staticDict` share `_viaBrand: 'i18n'` and the same `onMissing`/`substitute`
label-resolution policy engine as `i18nText`.

**`dictKey()`/`staticDict()` are now aliases** (#650, phase D): both compile onto the `'lookup'`
via-binding (`shape/via-lookup/`) — `dictKey()` onto its reserved tier (`dict()`'s native
spelling), `staticDict()` onto its static tier (`lookup(name, { backing: 'static', table })`'s
native spelling). Stored envelopes, `describe()` output, and `.join()` dressing are byte-identical
between an alias and its native equivalent, locked by
`packages/hub/__tests__/via/lookup-alias-parity.test.ts` — this is not a deprecation, both
spellings are fully supported going forward. The native `lookup()`/`enum()`/`dict()` surface adds
capability the aliases don't have: altKeys, closed-vocabulary write refusal, a first-class
reference-collection ("matrix") tier, and `restrict`/`cascade`/`nullify` reference semantics on
delete/forget. See [`docs/subsystems/via-lookup.md`](via-lookup.md) for the full story.

## Dictionaries — `vault.dictionary(name)`

`dictKey()`-backed dictionaries are **vault-scoped** reserved collections named `_dict_<name>`,
encrypted under the vault's own DEK like any other collection. Manage entries through
`vault.dictionary(name)`:

```ts
const statusDict = vault.dictionary('status')
await statusDict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
await statusDict.rename('paid', 'settled')   // the only sanctioned mass-mutation path
const entries = await statusDict.list()
```

`rename()` atomically writes the new key, rewrites every registered `dictKey` reference across
collections, and deletes the old key. `staticDict()` fields have no dictionary and no
`vault.dictionary()` handle — their table lives in code.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- `packages/hub/src/shape/via-i18n/` — the descriptors, binding, and dictionary machinery
