# Issue #81 — feat(core): dictKey schema type + reserved _dict_* collection + dictionary admin operations

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.8.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#78 — see [`ROADMAP.md` § v0.8](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md#v08--internationalization--dictionaries) for the surrounding scope and rationale, and [`NOYDB_SPEC.md` § Zero-Knowledge Storage](https://github.com/vLannaAi/noy-db/blob/main/NOYDB_SPEC.md#2-zero-knowledge-storage) for the invariant clarification this epic builds on.

## Problem

Real schemas have bounded enum-like fields (status, category, role, filing type, payment method, country code) where the *set* of valid values is known and the *labels* differ per locale. Today consumers solve this two incompatible ways at once:

- **Store the label as a string.** Fragile — renames are O(records), `groupBy('status')` produces different buckets per reader's locale, no referential integrity, no audit trail when a label is renamed.
- **Store a key + resolve from a locale file.** Locale file drifts from runtime data, can't be encrypted, can't be audited, can't be ledgered.

Neither solution is acceptable for a library whose threat model assumes encrypted records and whose architecture already has all the primitives needed: collections, schemas, refs, ledger, ACL.

## Proposed solution

A reserved encrypted collection per dictionary, plus a `dictKey` schema type that references it.

### `dictKey` schema type

```ts
const Invoice = z.object({
  id: z.string(),
  amount: z.number(),
  status: dictKey('status', ['draft', 'open', 'paid', 'cancelled'] as const),
  // runtime type narrows to: 'draft' | 'open' | 'paid' | 'cancelled'
})
```

- The `as const` keys passed at schema-construction time give the field a literal-union TypeScript type. **No codegen** — the runtime dictionary and the static keys can drift, and `noy-db verify` catches drift in CI.
- `dictKey` is a typed wrapper over v0.4 `ref('_dict_<name>')`. Same strict/warn semantics for missing keys.

### Dictionary collection

```ts
// Bootstrap
await company.dictionary('status').putAll({
  draft:    { en: 'Draft',    th: 'ฉบับร่าง' },
  open:     { en: 'Open',     th: 'เปิด' },
  paid:     { en: 'Paid',     th: 'ชำระแล้ว' },
})

// Read with locale resolution
const inv = await invoices.get('inv-1', { locale: 'th' })
// → { id: 'inv-1', amount: 5000, status: 'paid', statusLabel: 'ชำระแล้ว' }
```

- **Storage:** reserved collection name `_dict_<name>/`, encrypted under the same compartment DEK. Adapters still see ciphertext only.
- **One collection per dictionary**, not one collection with namespaces — composes with v0.4 refs naturally and inherits ACL, ledger, schema, and query primitives without any special-casing.
- **Per-call locale option** on `get`/`list`/`query`/`scan` — `{ locale: 'th' }`. Defaults to the compartment-open locale; throws if neither set and the field is read.
- **Per-open locale option** on `openCompartment` — `openCompartment(id, { locale: 'th' })` sets the compartment-default locale for the session.
- **`statusLabel`** (the resolved virtual field) is added to read results alongside the stable `status` key. The resolved label is **never written back** on `put()` — the consumer always writes the key.

### Dictionary admin operations

```ts
// Add or update labels (admin only by default)
await company.dictionary('status').put('overdue', { en: 'Overdue', th: 'ค้างชำระ' })

// Rename a key — the only legitimate "mass rewrite" path
await company.dictionary('status').rename('paid', 'settled')
// → atomically rewrites every record where status === 'paid' to status === 'settled'
// → ledger-tracks the rename as one entry (not N record-level entries)
// → respects ACL: throws if any referring record is in a collection the caller can't write

// Delete is strict by default — refuse if any record references the key
await company.dictionary('status').delete('cancelled')
// → throws DictKeyInUseError if any record has status === 'cancelled'
// → caller must rename or rewrite first
```

- **`rename(old, new)`** is the only mass-mutation path. Cascade-on-delete is **not supported** — it would be a mass mutation triggered by a delete, which the library does nowhere else.
- **Default delete is `strict`.** Warn mode is opt-in for development.
- **Per-dictionary permissions** fall back to compartment ACL by default. Admin-only writes by default; user-editable dictionaries (custom tags, user-defined categories) opt in via `dictionary('tags', { writableBy: 'operator' })`.

## Reserved collection name policy

- `_dict_*` is **reserved** at the API level. `compartment.collection('_dict_status')` throws `ReservedCollectionNameError`.
- `compartment.collections.list()` excludes `_dict_*` collections by default. Pass `{ includeReserved: true }` to see them.
- Naming pattern is enforced by the dictionary primitive itself — consumers never type the prefix manually.

## Out of scope

- **Type narrowing via codegen** — pragmatic `as const` is what ships
- **Cross-compartment shared dictionaries** — would cross the isolation boundary
- **Cascade-on-delete for dict keys** — `dictionary.rename()` is the only mass-mutation path
- **Pluralization, RTL, sorting collation** — see the i18nText issue for the out-of-scope statements that apply across both primitives
- **Query DSL behavior** (`groupBy(dictKey)` semantics, `.join()` on dictKey) — tracked in the query DSL integration issue

## Acceptance

- [ ] `dictKey(name, keys?)` schema type, with optional `as const` keys for literal-union narrowing
- [ ] `compartment.dictionary(name)` returns a typed dictionary handle with `put`, `putAll`, `get`, `delete`, `rename`, `list`
- [ ] Reserved `_dict_*` collection name policy enforced at API level
- [ ] Per-call `{ locale }` option on `get`, `list`, `query`, `scan`
- [ ] Per-open `{ locale }` option on `openCompartment`
- [ ] Resolved `<field>Label` virtual field on read results
- [ ] `DictKeyMissingError`, `DictKeyInUseError`, `ReservedCollectionNameError`
- [ ] `dictionary.rename()` is atomic, ledger-tracks as one entry, respects ACL
- [ ] Per-dictionary permissions with fallback to compartment ACL
- [ ] `noy-db verify` extension that compares dictionary contents against schema-declared key sets and fails if they drift
- [ ] Tests covering the literal-union narrowing, locale resolution, missing-key strict/warn behavior, rename atomicity, ACL on rename, and the reserved-name policy
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext — dictionaries are encrypted under the same compartment DEK
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged — dictionaries are collections, they use the existing read/write path
- [x] KEK never persisted; DEKs never stored unwrapped
- [x] Zero new external dependencies

v0.8.0 milestone. **Foundation issue** — every other v0.8 issue depends on this.
