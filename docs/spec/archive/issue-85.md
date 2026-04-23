# Issue #85 — feat(core): query DSL integration for dictKey — type-enforced groupBy + locale-aware join

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

Discussion vLannaAi/noy-db#78. Part of the v0.8 i18n epic. **Depends on `dictKey` (#81), `.join()` (#73), and aggregations v1 (the v0.6 feature spawned from discussion #65).**

## Problem

The query DSL extensions in v0.6 (joins, aggregations) are designed against the v0.5 schema surface, which doesn't yet have `dictKey`. When `dictKey` lands in v0.8, three things need explicit semantics:

1. **`groupBy` on a `dictKey` field must group by the stable key, never the localized label.** Grouping by the resolved label would produce different buckets per reader's locale, which is silently catastrophic — a Thai user's dashboard would show different revenue distributions than an English user's, with no error to indicate the discrepancy.
2. **`.join()` on a `dictKey` field should resolve the label in the caller's locale**, the same way `.get()` does.
3. **Both behaviors must be enforced by the type system**, not just docs. A consumer who calls `groupBy('statusLabel')` (the resolved virtual field) should get a **compile error**, not silently wrong groups.

This is a thin issue but the type-level enforcement is the load-bearing piece. Without it, the documentation says one thing and TypeScript permits the wrong thing — and "the type system permitted my code that's silently wrong in production" is the worst class of bug noy-db can ship.

## Proposed solution

### `groupBy(dictKey)` — type-enforced to use the stable key

```ts
const Invoice = z.object({
  id: z.string(),
  amount: z.number(),
  status: dictKey('status', ['draft', 'open', 'paid'] as const),
})

// ✅ Works — groups by the literal-union key type
const totalsByStatus = invoices.query()
  .groupBy('status')
  .aggregate({ total: sum('amount') })
  .toArray()
// → [
//     { status: 'draft', total: 1500 },
//     { status: 'open', total: 8200 },
//     { status: 'paid', total: 12400 },
//   ]

// ❌ Compile error — 'statusLabel' is the resolved virtual field, not a real property
const wrong = invoices.query()
  .groupBy('statusLabel')   // Error: Argument of type '"statusLabel"' is not assignable
  //                          to parameter of type keyof Invoice
  .aggregate({ total: sum('amount') })
```

The `Invoice` type at the type level **does not include `statusLabel`** — that's a virtual field added at read time only when `{ locale }` is set. `groupBy` accepts only `keyof Invoice`, which excludes virtual fields entirely. The compile error falls out for free if `dictKey`'s type narrowing (#81) is correct.

### `.join('clientId').join('status')` — locale-aware label resolution

A `.join()` over a `dictKey` field is a special case of the v0.6 join planner: instead of joining against another collection, it joins against the dictionary collection (`_dict_status/`) and resolves to the caller's locale.

```ts
const rows = invoices.query()
  .where('amount', '>', 1000)
  .join('status', { as: 'statusInfo' })
  .toArray({ locale: 'th' })
// → [
//     { id, amount, status: 'paid', statusInfo: { en: 'Paid', th: 'ชำระแล้ว', label: 'ชำระแล้ว' } },
//     ...
//   ]
```

- The joined `statusInfo` carries **all language values plus the resolved `label`** so a consumer rendering a multi-language report can access any locale.
- The join uses the dictionary's existing in-memory snapshot (no extra read), so the cost is one O(1) lookup per row.
- Joining against `_dict_*` is a one-line special case in the v0.6 planner — the dictionary collection is already loaded in memory at compartment open.

### Aggregations + dictKey

```ts
// ✅ groupBy stable key, then resolve the label only in the result projection
const summary = invoices.query()
  .groupBy('status')
  .aggregate({
    total: sum('amount'),
    count: count(),
  })
  .toArray({ locale: 'th' })
// → [
//     { status: 'draft', statusLabel: 'ฉบับร่าง', total: 1500, count: 3 },
//     ...
//   ]
```

- The result projection adds a `<field>Label` virtual field for any `dictKey` field present in the result, resolved to the caller's locale.
- The grouping itself happens on the stable key — no localization in the hot path.

## Why this is its own issue and not bundled into the v0.6 join/aggregation issues

The v0.6 issues (#73, #74, #75, and the aggregations v1 issue) ship **before** `dictKey` exists. They are designed against the v0.5 schema surface and cannot reference a primitive that doesn't exist yet. This issue lands in v0.8 and **extends** the v0.6 query DSL with the dictKey-specific behaviors.

The integration is small (~50 LOC of planner code + a type-level constraint on `groupBy`'s parameter type), but it touches both subsystems at once and benefits from being reviewed as a single dictKey-aware patch rather than scattered across v0.6 + v0.8.

## Acceptance

- [ ] `groupBy('statusLabel')` produces a TypeScript compile error (test via `tsd` or `expect-type`)
- [ ] `groupBy('status')` on a `dictKey` field produces buckets keyed by the stable literal-union value
- [ ] `.join('status', { as: 'statusInfo' })` on a `dictKey` field resolves against the dictionary collection's in-memory snapshot
- [ ] The joined result includes all language values + a resolved `label` field in the caller's locale
- [ ] Result projection of `groupBy + aggregate` adds `<field>Label` for any `dictKey` field in the result
- [ ] Tests covering: stable-key grouping with two locales asserting both produce the same bucket count; type-level `groupBy` rejection of virtual fields; join resolution; result projection's label field
- [ ] Documentation note in the query DSL chapter explaining "dictKey fields group by stable key, never by label"
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped
- [x] Zero new external dependencies

v0.8.0 milestone. Depends on #81 (v0.8 dictKey), #73 (v0.6 join planner), and the v0.6 aggregations v1 issue (TBD).
