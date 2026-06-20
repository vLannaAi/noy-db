# i18n v1.x tail (#435) — `densifyOnWrite` + `i18n:script-violation` event — design

> Closes the two genuinely-deferred items split out of the i18n hardening epic
> (#285, whose per-layer `onMissing` wiring shipped). Both land as new *optional*
> capabilities inside the tree-shaken `withI18n()` strategy — zero behavior change
> for any field that does not opt in.
>
> **Foundation decision (unchanged from the parent epic): extend in place.** New
> code lives behind the i18n strategy seam; the `NO_I18N` default bundle is
> untouched. Kernel files (`collection.ts`, `vault.ts`) hold only thin call sites.
>
> Parent spec: [`2026-06-05-i18n-multilingual-field-hardening-design.md`](./2026-06-05-i18n-multilingual-field-hardening-design.md)
> (densify is Slice 4 there; the script-violation event is the observability tail
> of the script-enforcement model).

## The two features

| # | Feature | One line |
|---|---|---|
| **F1** | `densifyOnWrite` | Eager-fill empty i18n slots from the substitute chain **at write time**, recording provenance so a derived copy is never mistaken for an authored translation. |
| **F2** | `i18n:script-violation` event | A typed event-bus channel that surfaces the `ScriptWarning[]` already collected by `'warn'`/`'filter'` script-enforcement modes (today silently discarded). |

They are independent and ship as separate slices. F2 is small and lands first.

## What already exists (reused, not rebuilt)

| Capability | Where (`file:line`) | Reused as |
|---|---|---|
| Read-time substitute chain | `i18n/core.ts:318-405` — `toChain()`, `pickFromChain()`, `resolveI18nText()` | The exact resolution F1 replays **at write time** to compute a fill value |
| Per-layer policy resolution | `i18n/policy.ts:47-57` — `resolvePolicy()` | The mutual-exclusion check (densify vs a `'throw'` policy) reads this |
| Read-time locale application | `i18n/core.ts:547-570` — `applyI18nLocale()` | Where the `_i18nFilled` marker is **stripped** from localized read output |
| `I18nTextOptions` field config | `i18n/core.ts:102-165` | F1 adds `densifyOnWrite?: boolean` here |
| Write path (normalization sequence) | `collection.ts:1395-1484` — auto-translate → `enforceScript` → required-validate → FK → encrypt | F1 inserts the densify step; F2 emits at the `enforceScript` site |
| Script enforcement | `i18n/script.ts:138-167` — `enforceScript()` returns `{ value, warnings }` | F1 gains a skip-set param; F2 consumes the returned `warnings` |
| `ScriptWarning` type | `i18n/script.ts:123-128` — `{ field, locale, expected, sample }` | F2 event payload (no new type) |
| Typed event emitter | `events.ts:6-40` — `NoydbEventEmitter` (`on`/`off`/`emit`) | F2 channel rides this — no new surface |
| Event map | `types.ts:1056-1105` — `NoydbEventMap`, `domain:verb` convention (`sync:push`, `history:save`) | F2 declares `'i18n:script-violation'` here |

## Architecture — where it sits

```
                          write path (collection.ts)
  ┌──────────────────────────────────────────────────────────────────┐
  │ auto-translate (1395)                                             │
  │   │                                                               │
  │   ▼  ❶ computeExemptFills(prior, incoming)  ◄── NEW pre-pass      │
  │   │     (only when a field has densifyOnWrite:true)               │
  │   ▼                                                               │
  │ enforceScript (1445)  ── checks AUTHORED slots only ──────────────┼──► F2: emit
  │   │     (exempt set = unchanged round-tripped fills)              │    i18n:script-violation
  │   ▼                                                               │    for warn + filter
  │ required-validate (1468)  ── authored floor, fills excluded ──────┤
  │   ▼                                                               │
  │   ❷ densify(prior, incoming)  ◄── NEW: fill + mark + refresh      │
  │   ▼                                                               │
  │ FK refs (1475) → encrypt + persist (1484)                         │
  └──────────────────────────────────────────────────────────────────┘
       ❶ ❷ are thin delegations into i18nStrategy (Approach A)
       all logic lives in i18n/densify.ts, tree-shaken under withI18n()
```

**Approach A (chosen).** Densify logic lives in a new `i18n/densify.ts`, invoked
through the existing `i18nStrategy` exactly as `enforceScript()` already is
(`collection.ts:1445`). Net new lines in `collection.ts` are call sites only
(~12-15) → a small, playbook-sanctioned ceiling raise. Rejected: a `SubsystemBus`
handler (densify is a pre-encryption record transform, not cleanly a gate) and
inline kernel code (bloats the file the architecture check keeps thin).

## F1 — `densifyOnWrite`

### Option

```ts
interface I18nTextOptions {
  // … existing …
  readonly densifyOnWrite?: boolean   // NEW — default absent ⇒ today's behavior
}
```

Per-field, opt-in. When set, after an i18nText value passes the authored gates,
every empty declared-language slot is filled from the field's substitute chain and
the fill is recorded in a provenance marker.

### Provenance marker

A reserved record-level sibling key:

```ts
_i18nFilled: Record</* fieldPath */ string, /* locale codes */ string[]>
// e.g.  { firstName: ['en'] }
```

- Stored **as part of the record**, therefore encrypted with it — zero-knowledge
  is preserved (the store still sees only ciphertext).
- **Fully internal.** Stripped from `get`/`list`/`raw` output by a filter in
  `applyI18nLocale()` (`core.ts:547`). It is **not** part of the user schema and
  callers never round-trip it.
- Surfaced only to: (a) `as-*` export (so an export can annotate a slot as
  *auto-filled*), and (b) a dedicated audit accessor (read-side, returns the
  marker for a record). Both are additive, out of the hot read path.

The marker holds **which** slots are derived, not their values — the values live
in the (now dense) locale map itself, so existing downstream layers (join, MV,
derivation, export) see a hole-free map with no per-layer plumbing. (This is the
whole point of densify versus read-time substitution: the stored map is dense.)

### Write algorithm (the precise sequence)

Let `prior` = the existing stored record (its dense locale map **and** its
`_i18nFilled` marker); `incoming` = the new record's locale map for a
densify-enabled field. On **insert** `prior` is empty.

**❶ `computeExemptFills(prior, incoming)` — pre-pass, before `enforceScript`.**
For each locale `L` that `prior._i18nFilled[field]` marks as filled:

| Incoming state of slot `L` | Classification | Consequence |
|---|---|---|
| empty | user cleared it | re-fill in ❷; nothing to script-check |
| `incoming[L] === prior[L]` (unchanged) | still a derived fill (client round-tripped it) | **exempt** from `enforceScript`; refresh in ❷ |
| `incoming[L] !== prior[L]` (changed) | user authored a real value into a formerly-filled slot | **not** exempt — script-checked as authored; marker for `L` cleared in ❷ |

The function returns the exempt-locale set. This is the keystone that lets a
dense map (which contains, e.g., Thai text in the `en` slot) survive a second
write without `enforceScript` rejecting the derived copy — **without** exposing
the marker to clients.

**Step `enforceScript` (1445)** runs on `incoming` **minus the exempt set**.
Authored slots (including a value newly authored into a formerly-filled slot) are
validated; unchanged round-tripped fills are skipped.

**Step required-validate (1468)** counts **authored** slots only (exempt fills do
not satisfy `required`) — `required` remains the authored floor, independent of
densify, exactly as the parent spec specified (no `store` layer).

**❷ `densify(prior, incoming)` — after required-validate, before FK/encrypt.**
For the field:
1. `authored` = incoming slots that are non-empty and not in the exempt set.
2. For each declared language `L` that is empty (or an exempt fill): compute a
   substitute by replaying `resolveI18nText`/`pickFromChain` over `authored`
   using the field's declared `substitute` (and `smartSubstitute` if set). If a
   value is found, set `map[L] = value` and mark `L` filled.
3. For any `L` now authored, **clear** its mark.
4. Write `_i18nFilled[field]` = the marked locales (omit the field — and the whole
   `_i18nFilled` key — when none remain).

Because ❷ recomputes fills from the current authored slots on **every** write,
a corrected source value propagates to its derived slots automatically — the
"`th` corrected → `en` re-densifies" behavior — with **no** authored value ever
clobbered (changed slots are reclassified as authored in ❶).

### Refresh mechanism — decision A (chosen)

Refresh reads the **prior marker from store**; the marker stays fully internal and
never round-trips. Rejected alternative B (marker round-trips on raw reads): lower
write cost but exposes the marker and breaks when a client drops it.

> **Planning-time verification (risk).** Decision A requires `prior` (its map +
> marker) to be available in the write path **before** `enforceScript`. The
> versioned/CRDT update path very likely already loads the prior record
> (`collection.ts:1484+`); confirm during planning. If prior state is **not**
> cheaply available for plain puts, the fallback is decision B (round-trip the
> marker) — a spec amendment, not a redesign, since ❶/❷ then read the incoming
> marker instead of `prior`.

### Mutual exclusion with `'throw'` policies

`densifyOnWrite: true` fills every hole, so any `onMissing: 'throw'` (the parent
spec's strict-MV case, and any other layer) becomes **unreachable**. Declaring
both is a contradiction:

- `densifyOnWrite: true` **+ an explicit `onMissing` containing `'throw'`** (scalar
  or any per-layer value) → **config-time error** (thrown when the field
  descriptor is built / collection constructed), naming the field and the
  offending layer(s).
- `densifyOnWrite: true` with **no explicit** `onMissing` → fine. The *default*
  `'throw'` is allowed; densify simply makes it never fire.

### Script-exemption interaction (worked)

| Write | Effect |
|---|---|
| Insert `{ th: 'สมชาย' }`, `languages:['th','en']`, `substitute:['en','th']`, `densifyOnWrite` | `enforceScript` checks `th` (valid Thai) ✓; required `'any'` ✓; ❷ fills `en:'สมชาย'`, marker `{firstName:['en']}`. Stored map is dense; `en` holds Thai by design. |
| Update `{ th: 'สมชัย', en: 'สมชาย' }` (client round-tripped the fill) | ❶ sees `en` marked & unchanged → exempt; `enforceScript` checks only `th` ✓; ❷ refreshes `en:'สมชัย'`, marker keeps `en`. **No script rejection, no clobber.** |
| Update `{ th: 'สมชาย', en: 'Somchai' }` (user authored real English) | ❶ sees `en` marked but **changed** → not exempt; `enforceScript` checks `en='Somchai'` (Latin ✓); ❷ marks `en` authored → clears mark; `_i18nFilled` drops `en`. |
| Read (active `en`) | resolver returns `'สมชัย'` (dense slot); `_i18nFilled` stripped from output. |
| Audit accessor | returns `{ firstName: ['en'] }` — `en` is derived. |

## F2 — `i18n:script-violation` event channel

### Channel

Declared in `NoydbEventMap` (`types.ts:1056`), `domain:verb` convention:

```ts
interface NoydbEventMap {
  // … existing …
  'i18n:script-violation': {
    readonly vault: string
    readonly collection: string
    readonly id: string
    readonly mode: 'warn' | 'filter'
    readonly warning: ScriptWarning   // { field, locale, expected, sample }
  }
}
```

### Emit site & modes

At `collection.ts:1458`, where `enforceScript()`'s `warnings` are **currently
discarded**, emit one event per warning:

```ts
for (const w of warnings) {
  emitter.emit('i18n:script-violation', { vault, collection, id, mode, warning: w })
}
```

| Mode | Behavior | Event |
|---|---|---|
| `'reject'` (default) | throws `ScriptViolationError` | **none** — the caller already sees the thrown error; an event-before-throw would falsely imply the write succeeded |
| `'warn'` | stores value as-is | **emits** |
| `'filter'` | strips disallowed chars before storing | **emits** — the *only* signal that stored data was mutated |

### Subscribe

```ts
noydb.on('i18n:script-violation', (e) => {
  // audit/migration: e.mode === 'filter' means characters were dropped from e.warning.sample
})
```

No new subscription surface — the existing `NoydbEventEmitter` API.

## Error & edge cases

- **Substitute exhausted on densify** (no authored slot to copy from, e.g. a
  field absent on the record): densify fills nothing, marks nothing — a no-op.
  The slot stays empty; read-time policy still applies. (This is the narrow state
  in which a `'throw'` policy *could* fire, which is why the mutual-exclusion rule
  is config-level intent, not a runtime guarantee.)
- **`smartSubstitute`** is honored if the field declares it (densify replays the
  same `resolveI18nText` path that read uses).
- **CRDT mode**: `_i18nFilled` is an ordinary record field and merges last-write-
  wins like the rest of the record; per-locale CRDT merge remains out of scope
  (unchanged from the parent epic).
- **`locale:'raw'` reads**: the locale map is returned dense (fills included);
  `_i18nFilled` is still stripped (marker is internal, audit-accessor only).
- **Non-densify fields** in the same collection are completely untouched by ❶/❷.

## Build sequence (independently shippable slices)

1. **F2 — event channel** *(Slice 1, small, ships first)*. Declare
   `'i18n:script-violation'` in `NoydbEventMap`; emit at `collection.ts:1458` for
   `warn`/`filter`. No dependency on F1. *(TDD: subscribe, write violating value
   under each mode, assert event/throw.)*
2. **F1 — `densifyOnWrite`** *(Slice 2, ships whole — fill, marker, exemption,
   refresh, read-strip, and mutual-exclusion are entangled; an intermediate
   "fill-only without exemption" state would break on round-trip)*. Add the
   option; `i18n/densify.ts` with `computeExemptFills` + `densify`; thin call
   sites in `collection.ts`; marker strip in `applyI18nLocale`; audit accessor;
   config-time mutual-exclusion check. *(TDD: the four-row worked table above,
   plus mutual-exclusion error and substitute-exhausted no-op.)*

## Testing & non-code obligations

- **TDD** throughout; conformance on `to-memory` **and** `to-file`.
- **Zero-breaking-change proof:** the existing i18n conformance suite stays green;
  add a test asserting a non-densify, non-`warn`/`filter` field is byte-identical
  to today.
- **Tree-shaking:** verify the `NO_I18N` default bundle size is unchanged (all new
  logic inside `withI18n()`).
- **`features.yaml`:** register both capability nodes (`densifyOnWrite`,
  `i18n:script-violation`) or CI's "Spec coverage" job fails on dangling refs.
- **Subsystem doc:** extend `docs/subsystems/` i18n section with the densify
  write-sequence table and the event channel.
- **Showcase:** extend the bilingual i18n showcase with (a) a densify fill +
  audit-accessor read proving the marker, and (b) a `'filter'`-mode subscription
  asserting an `i18n:script-violation` event fires when characters are stripped.
- **Kernel ceiling:** raise `collection.ts` ceiling (`scripts/check-architecture.mjs`)
  by the minimal amount the Approach-A call sites require (~15 lines); keep
  `vault.ts` untouched.

## Out of scope (restated)

Nearest-script *smart* substitution beyond the existing `smartSubstitute` flag,
lazy on-read translation, per-locale CRDT merge, native-digits-only enforcement —
all remain deferred per the parent epic. The in-pinia reactive-locale companion is
**already shipped** (PR #284) and is not part of this work.
