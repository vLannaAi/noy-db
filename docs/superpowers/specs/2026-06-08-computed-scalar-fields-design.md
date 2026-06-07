# computed — first-class computed scalar fields

**Issue:** #302 (Pilot-3 / i3speedex delegation gap) · **Layer:** Schema · **Cluster:** A (schema fields), builds on #300 `money()`.

## Problem

Line/sale totals (`netAmount`, `taxAmount`, `total`) are computed in handlers, scattered across userland. `derivations` (#200) can *store* derived results but a full output collection is heavy for a single scalar, and the formula lives outside the schema. The pilot wants the arithmetic next to the schema, the result a first-class validated/queryable field.

## Goal

A lightweight per-collection `computed: { total: (rec) => ... }` the schema layer evaluates **on write**, materializing the result onto the record so it is a first-class field — typed, schema-validated, queryable, and `sum()`-able. Distinct from `derivations` (row→rows, separate collection) and from `money()` (storage/format of a value, not its derivation).

## Core principle

**Computed values are materialized inputs, evaluated before validation.** A computed field is derived from the record's other fields at write time, injected into the record, then flows through the normal write pipeline (schema validation, money quantize, encryption) exactly as if the user had supplied it. Read returns the stored value — no recomputation, so it queries and aggregates like any field.

## 1. Public API

```ts
vault.collection('lines', {
  schema: z.object({
    id: z.string(),
    unitPrice: z.number(),
    qty: z.number(),
    netAmount: z.number(),   // computed — user need not supply
    taxAmount: z.number(),   // computed
    total: z.number(),       // computed, may read prior computed fields
  }),
  computed: {
    netAmount: (r) => r.unitPrice * r.qty,
    taxAmount: (r) => r.netAmount * 0.22,
    total: (r) => r.netAmount + r.taxAmount,
  },
})
```

- `computed` is `Record<fieldPath, (record) => unknown>` — pure, **synchronous** functions.
- Evaluated in **declaration order**; each function sees the record *with all prior computed fields already injected* (so `total` can read `netAmount`/`taxAmount`).
- A computed function reads input fields only — **no vault access, no async** (that boundary is #299's cross-record validators).

## 2. Write path

Computed evaluation runs **first** in `putInternal`, before schema validation:

1. For each `[field, fn]` in `computed` (declaration order): set `record[field] = fn(record)`. A computed field **overwrites** any user-supplied value of the same name — the field is schema-owned, not user input. A throwing `fn` rejects the put with a typed **`ComputedFieldError`** (field, id, cause).
2. The record (now carrying computed values) proceeds to schema validation → money quantize → i18n → refs → encryption.

Running before schema validation means: (a) the user is not required to supply computed fields; (b) the schema validates the computed *result* (type/range); (c) a computed field declared as `money()` is quantized by the money layer in the same write.

## 3. Read path

No special read handling — the materialized value is stored and returned as-is. It participates in `query()`, indexes, and `aggregate()` (incl. exact money `sum()` when the computed field is also a `money()` field) like any stored field.

## 4. Money interplay (#300)

A computed field may also be a `money()` field. Order is computed → money-quantize, so:
- The computed `fn` returns a decimal `number | string`; money-quantize then stores it as the exact scaled-integer string.
- **Exactness caveat (documented):** the computed `fn` is user code doing JS arithmetic on its inputs; if those inputs are themselves money, the `fn` runs *before* quantization and operates on raw input, so intermediate float drift is the author's responsibility. v1 does not provide money-exact computed arithmetic — the function may use the exported money helpers if exactness matters. `sum()` over the *stored* computed money field is still exact (it reads the quantized integer).

## 5. Boundaries & interplay

- **Schema ordering:** computed is the **first** write-pipeline stage, before `validateSchemaInput`. i18n/refs/money all run after, unchanged.
- **Architecture:** logic lives in a new `src/computed/` module (`evalComputedFields`); `putInternal` gains one thin guarded call (mirrors the money-quantize call site). The collection-surface footprint is a field + option + one call; the kernel-surface ceiling is bumped if needed, with justification, exactly as money did.
- **Determinism:** functions should be pure; non-determinism (Date.now, random) produces a stored snapshot at write time — documented, not policed.

### Deferred (separate issues, not v1)

- Read-time **drift validation** (re-evaluate on read, flag if the stored value disagrees — for catching formula changes).
- Async / cross-record computed (that is #299's domain).
- Computed-field dependency analysis beyond declaration order.

## 6. Testing

- Computed value injected on write, stored, and returned on read.
- Declaration-order chaining: `total` reads `netAmount`/`taxAmount` computed earlier in the same write.
- Computed **overwrites** a user-supplied value of the same name.
- Schema validates the computed result (a computed value violating the schema rejects).
- A throwing `fn` rejects with `ComputedFieldError`.
- `aggregate(sum())` over a computed field is correct; over a computed **money** field is exact.
- `put` without supplying computed fields succeeds (not a missing-field schema error).

## Build sequence

1. `src/computed/` — `ComputedFields` type, `evalComputedFields(record, computed)`, `ComputedFieldError`.
2. Wire `computed` option through vault → collection; evaluate first in `putInternal`.
3. Tests: write/read, chaining, overwrite, schema interplay, error, money-sum.
4. Exports + README + features.yaml entry; kernel-surface fit.
