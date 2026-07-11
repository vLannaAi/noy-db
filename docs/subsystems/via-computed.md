# Computed fields — the `computed` via-feature

Since #638 (phase C), `computed` is a **via-feature**: `computed(fn, { deps, mode })` composes
through `via(...)` (and through an extended `computed: { field: { fn, deps, mode } }` sugar form)
exactly like money, i18n, classified, and blob. `deps` names the source field(s) `fn` reads —
used by the [dependency graph](via.md) to fold each derived field's effective security posture
from its sources — and `mode` picks how the value is produced:

- **`mode: 'materialized'`** (the default) — byte-for-byte today's write-time eager compute:
  `fn` runs once per `put()`, its output is stored like any user-supplied value.
- **`mode: 'virtual'`** — read-time only: `fn` runs fresh on every `present()` (`get()`/`list()`),
  the field is **never stored** (absent from `_data`, absent from `_getStoredRecord()`), and it is
  unconditionally `queryable: 'none'`.

## Declaring fields

```ts
const c = v.collection<Item>('items', {
  viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })) },
})
await c.put('r1', { id: 'r1', amount: 21 })
;(await c.get('r1'))?.doubled // 42
```

(from `packages/hub/__tests__/computed/virtual.test.ts`, test (a)). The plain `computed:` sugar
key accepts the same `{ fn, deps, mode }` shape per entry (or a bare function, which defaults to
`mode: 'materialized'`, `deps: undefined`) — this is what phase C Task 2's now-removed `@internal
computedDeps` sibling option was staged behind; `computedDeps` itself is gone (folded into each
entry's own `deps`, per Task 7 — see Architecture below).

## Virtual mode — read-time, never-stored

The raw stored record never contains the field:

```ts
const raw = await c._getStoredRecord('r1')
'doubled' in (raw as Record<string, unknown>) // false
```

(`virtual.test.ts`, test (b)). Querying it always throws `FieldNotQueryableError` — `queryable:
'none'` is unconditional for a virtual field, not just taint-driven:

```ts
expect(() => c.query().where('doubled', '==', 42)).toThrow(FieldNotQueryableError)
```

(`virtual.test.ts`, test (c)). A virtual computed field riding alongside money on the same
collection does not disturb money's own **synchronous** query stack (the #553 guarantee): `.where()`
on a money field still resolves without `await`, and reading the virtual field alongside it works
normally:

```ts
const results = c.query().where('price', '>', 10).toArray()   // no `await` — still sync
expect(results.map((r) => r.id)).toEqual(['b'])
expect((await c.get('a'))?.doubled).toBe(6)
```

(`virtual.test.ts`, test (d), a `moneyFields: { price }` + `viaFields: { doubled: via(computed(...,
{ mode: 'virtual' })) }` collection).

## Materialized mode — byte-identical to the plain `computed:` sugar

`via(computed(fn, { mode: 'materialized' }))` and the bare `computed: { doubled: fn }` sugar
produce identical envelopes and identical reads:

```ts
const sugarCol = sugarVault.collection<Item>('items', { computed: { doubled: fn } })
const viaCol = viaVaultDb.collection<Item>('items', { viaFields: { doubled: via(computed(fn, { mode: 'materialized' })) } })
// same _noydb / _v envelope fields; get() results deep-equal; both store `doubled` (unlike virtual mode)
```

(`virtual.test.ts`, test (e)). Materialized mode evaluates `fn` in `_putInternal` **before**
`this.via.encodeWrite` runs — its output merges into the record exactly like user input, so any
other feature stacked on the same field (money, i18n) applies to it normally.

## Composition — `via(computed(...), money(...))`: money formats materialized, not virtual

`compileViaBindings` always runs `computed` **last** in the feature stack (money → i18n →
classified → blob → computed), so a computed `fn`'s `deps` can read other fields' already-decoded
presentation (a money-quantized amount, an i18n-resolved label). Composing computed **with**
another feature on the **same field** is legal in both modes, but the two modes behave oppositely
because of this ordering, pinned as two separate, deliberate assertions:

```ts
// VIRTUAL: money's present() runs first (nothing to decode yet), computed's runs last and
// unconditionally overwrites — the raw computed number survives, NOT a money-formatted string.
const c = v.collection<Priced>('priced', {
  viaFields: { doubledPrice: via(computed((r) => (r.base as number) * 2, { deps: ['base'], mode: 'virtual' }), money({ currency: 'EUR', scale: 2 })) },
})
await c.put('a', { id: 'a', base: 10.5 })
;(await c.get('a'))?.doubledPrice // 21 (a plain number, not '21.00')
```

```ts
// MATERIALIZED (default): computed's output is evaluated before encodeWrite, so money's own
// encode/decode/present hooks cover it exactly like a plain money field.
const c = v.collection<Priced>('priced', {
  viaFields: { total: via(computed((r) => (r.base as number) * 2, { deps: ['base'], mode: 'materialized' }), money({ currency: 'EUR', scale: 2 })) },
})
await c.put('a', { id: 'a', base: 10.5 })
;(await c.get('a'))?.total // '21.00' — money-formatted
```

(both from `virtual.test.ts` — "composed grammar" and "composed grammar (MATERIALIZED default)").
Money-decorating-a-virtual-field's-own-output (i.e. having money format the computed value in
`mode: 'virtual'`) is a known, accepted limitation, not implemented.

## Taint propagation — inherits the strictest source posture (#636)

A computed field's effective security posture is not fixed by its own declaration — it is **folded
from its `deps`' postures** by the [dependency graph](via.md#phase-c--dependency-graph-taint-enforcement-sync-dispatch-frozen-output-forget-fanout).
A **materialized** field computed from a classified source is sealed at rest through the same
`ctx.sealedSlots` capability `via-classified` uses, refused in the query DSL, and redacted on
export/`describe()`:

```ts
const c = v.collection<Person>('people', {
  classifiedFields: { ssn: ssnSpec() },
  computed: { ssnLeak: { fn: (r) => r.ssn, deps: ['ssn'] } },  // materialized (default)
})
await c.put('r1', { id: 'r1', name: 'Alice', ssn: '123-45-6789' })
const rec = await c.get('r1')
rec.ssnLeak instanceof SealedHandle       // true — not plaintext
JSON.stringify(rec.ssnLeak)               // '"[sealed]"'
```

(from `packages/hub/__tests__/via/taint.test.ts`, tests (a)-(e) — the #636 regression suite). A
**virtual** field computed from a classified source has nothing to seal (it's never stored), so it
is instead redacted with the export-redaction marker on **every** read, not just export:

```ts
const c = v.collection<Person>('people', {
  classifiedFields: { ssn: ssnSpec() },
  viaFields: { ssnLeak: via(computed((r) => r.ssn as string, { deps: ['ssn'], mode: 'virtual' })) },
})
await c.put('r1', { id: 'r1', ssn: '123-45-6789' })
;(await c.get('r1'))?.ssnLeak // '[sealed]' — a plain redacted string, not a revealable SealedHandle
```

(from `packages/hub/__tests__/computed/virtual.test.ts`, "a virtual field sourced from a classified
field is redacted on EVERY read"). **This is a behavior change** for any existing `computed`
configuration whose `fn` reads a classified field's plaintext — before #638 that plaintext (or a
derivative of it) survived `get()`/`list()`/export/query untouched; after #638 it is sealed
(materialized) or redacted (virtual). See the [changeset](../../.changeset/via-phase-c.md) for the
full upgrade note.

## Declare-time guard — depsless + classified is refused (the #636 typo-reopening fix)

A `computed` entry with **no declared `deps`** on a collection that also declares classified fields
throws `ValidationError` at construction — an opaque function could otherwise silently copy a
classified field's plaintext into an ordinary field with no way for the graph to know:

```ts
expect(() => vault.collection('leaky', {
  classifiedFields: { ssn: classified.email() },
  computed: { ssnLeak: (r) => r.ssn },   // no deps — refused
})).toThrow(ValidationError)
```

A **mistyped** `deps` entry on a classified collection is refused the same way — `deps` must name
a field the graph actually knows about:

```ts
expect(() => vault.collection('typo-leaky', {
  classifiedFields: { ssn: classified.email() },
  computed: { ssnLeak: { fn: (r) => r.ssn, deps: ['sssn'] } },   // typo for 'ssn' — refused
})).toThrow(ValidationError)
```

(both from `packages/hub/__tests__/via/graph-edges.test.ts`). On a **non-classified** collection, a
`deps` entry may name any field, including a plain field with no via feature at all — there is no
schema-introspection API to validate against (`StandardSchemaV1` exposes no field-list capability),
and an unregistered dep folds to `DEFAULT_POSTURE` (harmless) — this is what phase C Task 7's design
deliberately opened up (`graph-edges.test.ts`, "a computed field's deps may reference a PLAIN field
with no via feature at all").

**KNOWN LIMIT**, documented loudly and pinned so a future fix flips it consciously: the guard only
checks that `deps` names *some* known field, not that it names the field `fn` actually reads. A
`deps` entry naming a real, declared-but-**wrong** field (e.g. `fn: (r) => r.ssn` but `deps:
['amount']`, a real money field) still passes construction and still leaks — the graph edge folds
from `amount`'s posture, not `ssn`'s:

```ts
const c = v.collection<Person>('people', {
  moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
  classifiedFields: { ssn: ssnSpec2() },
  computed: { ssnLeak: { fn: (r) => r.ssn as string, deps: ['amount'] } },  // wrong-but-known dep
})
await c.put('r1', { id: 'r1', ssn: '123-45-6789', amount: 42 })
;(await c.get('r1'))?.ssnLeak // '123-45-6789' — still leaks
```

(`taint.test.ts`, "Task 7 review — KNOWN LIMIT"). Closing this fully would need runtime
read-tracking or a schema-aware capability — out of phase C's scope.

### Declaration-order asymmetry

The declare-time guard above is a **single-call** rule: it fires whenever a depsless computed field
and a classified field appear together in the **same** `vault.collection()` call, regardless of the
classified field's storage form. A **cross-call** (reconcile) memory additionally re-checks a
depsless computed field declared in an *earlier* call once a *later* call attaches a
**persistable** (`recoverable`/`digest-only`) classified field — but it deliberately does **not**
re-check a `storage: 'never'` attach, because `enforceClassifiedWrite` structurally rejects a
`never`-stored value before any computed field ever evaluates it, so a `never`-storage field cannot
leak through a computed field regardless of declaration order. The net effect: a `storage: 'never'`
classified field combined with a depsless computed field in **one** call is refused, but the
identical pairing split across **two** calls (depsless computed declared first, the `storage:
'never'` field attached in a later, separate call) is accepted — a structural guarantee, not a gap
(`graph-edges.test.ts`, compare "the MV-pre-creation reconcile path still runs the anti-leak guard"
against the "3-call pin (cm7)" fixture).

### Reconcile-path scope limit

A `computed` entry's `deps` are validated against a `knownFields` universe scoped to the **current**
`vault.collection()` call's own options only. Declaring `classifiedFields: { ssn }` in one call and
a `computed` field with `deps: ['ssn']` in a **later**, separate call over-refuses — the reconcile
path does not see the earlier call's classified declaration and throws `ValidationError` even
though the dependency is correct. This is fail-safe (it refuses rather than silently leaking); the
workaround is to declare the classified field and its dependent computed field together in the
**same** `vault.collection()` call, as every example above does. A cross-call knownFields union is
tracked as a follow-up, not implemented in phase C.

### Reconcile-only limit — virtual mode has no late-attach door

`mode: 'virtual'` is construction-only, matching `viaFields`/`i18nFields`/`dictKeyFields`'s existing
rule: a virtual field needs the computed via-binding compiled into `coll.via.bindings` at
construction time, which only happens once. Declaring `mode: 'virtual'` on a reconcile call throws:

```ts
v.collection<Item>('items', {})  // fresh, bare construction
expect(() => v.collection<Item>('items', {
  computed: { doubled: { fn: (r) => (r.amount as number) * 2, mode: 'virtual' } },
})).toThrow(ValidationError)
```

(`virtual.test.ts`, "mode: 'virtual' has no late-attach reconcile door").

## Architecture

`computedBinding(cfg)` (`packages/hub/src/shape/via-computed/binding.ts`) returns a `ViaBinding`
with `brand: 'computed'` and a **fixed** posture — `queryable: 'none'` unconditionally, independent
of taint:

```ts
const b = computedBinding({ virtualFields: new Map([['doubled', descriptor]]) })
b.posture // { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: false }
b.covers?.('doubled') // true — covers only its declared virtual fields
b.encodeAtRest         // undefined — a virtual field is never sealed/stored
b.buildClause           // undefined — no query-participation hooks at all
```

`present()` computes each virtual field from the accumulating record, in `Map` iteration order (so
one virtual field's `fn` may read another, already-computed, virtual field from the *same* call),
and never mutates its input:

```ts
const out = await b.present!({ id: 'x', amount: 5 }, { layer: 'read' })
out.doubled      // 10  (deps: ['amount'])
out.quadrupled   // 20  (deps: ['doubled'] — reads the same call's already-set value)
```

(all from `packages/hub/__tests__/via/computed-binding.test.ts`). The materialized case has **no**
dedicated binding — a materialized `computed:`/`via(computed(..., { mode: 'materialized' }))` field
compiles into `resolveCollectionConfig`'s existing `mergedComputed` map and is evaluated by
`evalComputedFields` in `_putInternal`, unchanged since before phase C. `computedBinding` covers
**only** virtual fields, and is deliberately compiled **last** in the via-binding stack for the
composition-ordering reasons described above.

The formerly-`@internal` `computedDeps` sibling option (phase C Task 2's staging seam, explicitly
documented as "do not depend on this shape") is **removed**, not aliased — folded into each
`computed` entry's own `{ fn, deps?, mode? }` shape, which the `computed:` sugar and
`via(computed(...))` now share identically.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port overview, the dependency graph, taint
  enforcement, sync dispatch, frozen-output, forget fanout (the cross-cutting phase C machinery
  `computed(virtual)` plugs into)
- [`docs/subsystems/via-classified.md`](via-classified.md) — the classified feature (the usual taint
  *source*)
- `packages/hub/src/shape/via-computed/` — `computed()`/`ComputedDescriptor`/`computedBinding`
- `packages/hub/__tests__/computed/virtual.test.ts` — the `mode: 'virtual'` suite (11 tests)
- `packages/hub/__tests__/via/computed-binding.test.ts` — the binding unit suite (6 tests)
- `packages/hub/__tests__/via/taint.test.ts` — the #636 taint-propagation regression suite
- `packages/hub/__tests__/via/graph-edges.test.ts` — the declare-time guard + reconcile-path suite
