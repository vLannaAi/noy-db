# i18n static / code-provided dictionary (hub core / i18n) — design

> Adds a **code-provided dictionary** primitive — `staticDict(name, table, opts?)` — for *closed, defined-in-code, identical-across-vaults* enums (honorific, civil-status, gender, religion, ContactTitle, status…). Labels are supplied **at registration in code** and resolved through the *same* label machinery as `dictKey`, but with **no `_dict_*` per-vault encrypted copy** and **no `rename()`**. The record stores only the **code**, so an app migrates onto it from a userland workaround with **zero record change**.
>
> **Foundation decision: a sibling descriptor that reuses the resolver seam, not a new subsystem.** `staticDict` produces a descriptor accepted in the existing `dictKeyFields` config slot. Label resolution flows through the same choke points as `dictKey` (`collection.ts` read path + the query label seam) — only the *source* of labels changes (an in-memory table instead of a `_dict_*`-backed handle). No new storage, no new query operators.
>
> **Resolution contract: hybrid (locale-aware **and** locale-less-resolvable).** Unlike `dictKey`, a static dict is pure code with no vault-locale dependency, so it can — and must, to be useful to a locale-less consumer — emit a label even when no locale is active, via a configured `displayLocale`. When a locale *is* active it behaves exactly like `dictKey` (inherits `onMissing`/`substitute`, `groupBy by:'key'`, `orderBy {by:'label'}`). This is the only contract that resolves the #291 contradiction (see § The contradiction this resolves).

Issue: [#291](https://github.com/vLannaAi/noy-db/issues/291). Consumer driver: `vLannaAi/niwat#174` (i18n native-adoption umbrella). Family: i18n hardening, **milestone #17** (sibling primitive to the #282/#283 parity work shipped in #284).

## Motivation — the practical issue

`dictKey` stores labels in a **per-vault encrypted `_dict_*`** collection (`i18n/dictionary.ts:48-59`) and rewrites pointers with an **O(records) `rename()`** (`dictionary.ts:450-522` → `vault.ts:1013-1040`, which lists every record in every registered collection). That is the right design for **user-editable, per-vault** enums.

But a large class of enums are the opposite: **closed, defined in code, identical across every vault, never renamed per-vault** — honorifics, civil status, gender, religion, ContactTitle, status enums. For these, `dictKey` is the wrong layer:

- it forces a **per-vault encrypted copy** of values that are really code constants;
- it needs an **O(records) `rename()`** for a change that is really a code deploy;
- under a **locale-less vault** (opened with no locale → bare reads return the raw map), a `dictKey` field's `<field>Label` does **not** auto-resolve on a bare read — the read path early-returns at `collection.ts:3042-3043` (`const locale = perCall ?? this.defaultLocale; if (!locale) return record`; locked by `dictionary.test.ts:350-367`). So every site needs a per-call resolver, and the call-site-reduction value of `dictKey` is undercut.

Confirmed in practice in the consumer (`niwat#174`): the app is **locale-less by a deliberate, locking-tested invariant** and *never consumes read-time `{locale}` resolution*. The `dictKey` seeded for honorifics sat **dormant** — every site used a sync code-level label helper instead — and the dormant dict was deleted. The app now ships a userland `defineStaticDict(name, { code: {th,en} })`. It works, but the resolving lives in user land rather than the engine — hence this request to embed it.

## The contradiction this resolves

The naïve reading of #291 — "embed the sync userland helper **and** route it through the existing `resolveLabel` locale path for parity" — cannot hold:

- the userland `defineStaticDict` is **synchronous and locale-less** — it resolves *because* it is pure code with no vault-locale dependency;
- the existing `resolveLabel` read path is **async and locale-gated** — its first act is `if (!locale) return record` (`collection.ts:3042-3043`).

Routing the workaround through that path would produce a primitive that resolves to **nothing** under a locale-less read — exactly the dormant-`dictKey` failure mode the issue complains about, and one the only known consumer (locale-less by invariant) **could not use at all**.

Yet the *only* thing that justifies engine-embedding over the working userland helper is **query integration** — `orderBy`/`groupBy {by:'label'}` and `onMissing`/`substitute` parity — which a pure sync helper cannot provide, and which inherently needs *a* locale at query time.

**Hybrid (this spec) is the resolution:** resolve through the locale path when a locale is active (full query integration + policy parity), and fall back to a configured `displayLocale` when no locale is active (preserves the locale-less consumer's ergonomics). It serves both the locale-aware future and the locale-less present without forking the descriptor.

## What already exists (and is reused, not rebuilt)

| Capability | Where | Reused as |
|---|---|---|
| `DictKeyDescriptor` shape + `dictKey()` factory | `i18n/dictionary.ts:79-126` | template for `StaticDictDescriptor` + `staticDict()` (distinct brand) |
| `dictKeyFields` config slot on `collection()` | `vault.ts:522-578`, wired at `752-758` | **same slot** accepts static descriptors — drop-in at config sites |
| Read-path label resolution (`<field>Label`, array-of-keys, wildcard `[].`) | `collection.ts:3053-3119` | the one read choke point; extended only at the locale **gate** (3042-3043) |
| `dictLabelResolver` closure | `vault.ts:752-758` | static variant closes over the **in-memory table**, not `dictionary(name).resolveLabel` |
| `onMissing` / `substitute` policy engine | `i18n/policy.ts` (`resolvePolicy`), applied `collection.ts:3056-3079` | unchanged; static descriptor carries the same fields |
| Query label seam | `query/builder.ts:739,1271` (`buildDictLabelResolver` → `joinCtx.resolveDictSource(field)` → `dictSource.snapshot()` → `Map`) | gets a **code-table-backed `dictSource`** whose `snapshot()` materialises the in-memory table |
| `groupBy`/`orderBy` key-vs-label binding | `aggregate/groupby.ts:347-381` (threaded resolver) | unchanged; binds to **key** by default, `{ by: 'label' }` opt-in |
| `i18nPutValidator` / `enforceI18nOnPut` | `vault.ts:761-765` | extended to validate the stored code against the static table's known keys |
| Tree-shake seam | `i18n/strategy.ts` (`NO_I18N`) / `i18n/active.ts` (`withI18n()`) | all new code lives here; non-i18n bundles pay nothing |

## What is deliberately NOT reused

| `dictKey` machinery | Why a static dict skips it |
|---|---|
| `_dict_*` encrypted collection (`dictCollectionName`, `i18n/dictionary.ts:48-59`) | labels are code constants — no per-vault storage |
| `dictKeyFieldRegistry` + `findAndUpdateReferences` (`vault.ts:1013-1040`) | no per-vault pointer rewrite; codes never change per-vault |
| `rename()` (`dictionary.ts:450-522`) | a label change is a code deploy, not an O(records) migration |
| `vault.dictionary(name)` handle `put`/`rename` API | a static dict exposes **no mutation surface**; attempting `put`/`rename` on a static name throws `StaticDictReadonlyError` (see registry note below) |

> **Static-name registry (small, new).** A static dict skips `dictKeyFieldRegistry` (no rename), but the `StaticDictReadonlyError` guard requires the vault to *know* a name is static so `vault.dictionary(staticName)` can refuse mutation. Maintain a `Set<string>` of static dict names, populated at `collection()` config time when a `StaticDictDescriptor` is seen in `dictKeyFields`. The guard and the Seam-1 resolver both read from it.

## Success criteria (acceptance)

- `staticDict(name, table, opts?)` produces a descriptor usable in the existing `dictKeyFields` slot; a record storing the bare **code** gains a resolved `<field>Label` on read.
- **Locale-less read with `displayLocale`:** `entities.get(id)` on a vault opened with **no** locale returns `civilStatusLabel` resolved via `displayLocale` (e.g. `'นาย'`). This is the property a locale-less consumer needs and `dictKey` cannot provide.
- **Locale-active read:** `get(id, { locale: 'en' })` returns `civilStatusLabel: 'Mr'`, honoring `onMissing`/`substitute` exactly as `dictKey` does.
- **No `_dict_*` collection** is created for a static dict; the adapter shows no `_dict_<name>` keys.
- **No `rename()`** path exists; `vault.dictionary(staticName)` mutation calls throw `StaticDictReadonlyError`.
- **Query parity:** `groupBy(field)` buckets by the stable **code**; `orderBy(field, { by: 'label' })` sorts by resolved label under the active (or `displayLocale`) locale.
- **Zero record change** to migrate from the userland workaround: the record already stores the code; only the field descriptor changes.
- **No behavior change** for any existing `dictKey` / `i18nText` field. The locale gate still early-returns for a locale-less read **unless** a static field declares `displayLocale`. Existing conformance tests (incl. `dictionary.test.ts:350-367`) stay green, **and a new locking test asserts an `i18nText`-only collection still returns the raw `{th,en}` map on a locale-less read** (the gate edit's regression guard — not covered by the dictKey test).
- New code lives entirely inside the tree-shaken `withI18n()` strategy.

## Descriptor API

```ts
// i18n/dictionary.ts (sibling to dictKey)
export interface StaticDictDescriptor<Keys extends string = string> {
  readonly _noydbStaticDict: true
  readonly name: string
  readonly table: Readonly<Record<Keys, Readonly<Record<string, string>>>> // key -> { locale -> label }
  readonly keys: readonly Keys[]                 // derived: Object.keys(table)
  readonly displayLocale?: string                // label emitted under a locale-less read (the hybrid hinge)
  readonly onMissing?: OnMissingPolicy           // same policy engine as dictKey
  readonly substitute?: readonly string[]        // declared preferred-locale chain
}

export function staticDict<const T extends Record<string, Record<string, string>>>(
  name: string,
  table: T,
  opts?: { displayLocale?: string; onMissing?: OnMissingPolicy; substitute?: readonly string[] },
): StaticDictDescriptor<Extract<keyof T, string>>

export function isStaticDictDescriptor(x: unknown): x is StaticDictDescriptor
```

Config site — drop-in alongside `dictKey`:

```ts
const workers = vault.collection<Worker>('workers', {
  dictKeyFields: {
    // per-vault, user-editable → dictKey (unchanged)
    department: dictKey('department', ['ops', 'fin'] as const),
    // closed, code-defined, identical across vaults → staticDict
    civilStatus: staticDict('civilStatus', {
      adultMale:   { th: 'นาย',  en: 'Mr'  },
      adultFemale: { th: 'นาง',  en: 'Mrs' },
      youngFemale: { th: 'นางสาว', en: 'Ms' },
    }, { displayLocale: 'th' }),
  },
})

// record stores only the code:
await workers.put({ id: 'w1', civilStatus: 'adultMale' })

await workers.get('w1')                  // locale-less vault → civilStatusLabel: 'นาย'  (displayLocale)
await workers.get('w1', { locale:'en' }) // → civilStatusLabel: 'Mr'
```

## v1 SCOPE — what's in

| Feature | In v1 | Notes |
|---|:---:|---|
| `staticDict(name, table, opts?)` + `StaticDictDescriptor` + `isStaticDictDescriptor` | ✓ | distinct `_noydbStaticDict` brand; lives in `i18n/dictionary.ts` |
| Accept static descriptors in the existing `dictKeyFields` slot | ✓ | `vault.ts:752-758` branches on descriptor brand |
| **Locale gate extension** (`collection.ts:3042-3043`) | ✓ | early-return suppressed only when a static field declares `displayLocale`; effective locale = `perCall ?? defaultLocale ?? desc.displayLocale` for static fields |
| Static resolver closure over the in-memory table | ✓ | `vault.ts` builds `dictLabelResolver` from `desc.table` for static names; no `dictionary()` lookup |
| `onMissing` / `substitute` parity via the existing policy engine | ✓ | `collection.ts:3056-3079` unchanged; default `'null'` (today's dictKey behavior) |
| Scalar, array-of-keys (`[{key,label}]`), and wildcard (`contacts[].title`) resolution | ✓ | reuses the same `collection.ts:3081-3116` branches |
| **No `_dict_*`, no registry, no `rename`** for static names | ✓ | static names skip `dictKeyFieldRegistry`; `vault.dictionary(staticName)` mutation → `StaticDictReadonlyError` |
| Query seam: code-table-backed `dictSource` for `resolveDictSource(field)` | ✓ | `query/builder.ts:1271` `buildDictLabelResolver` works unchanged; `snapshot()` materialises `table` → `[{key,labels}]` |
| `groupBy by:'key'` (default) / `orderBy { by:'label' }` (active or `displayLocale`) | ✓ | `aggregate/groupby.ts:347-381` unchanged |
| Put-time code validation against `desc.keys` | ✓ | `enforceI18nOnPut` (`vault.ts:761-765`) rejects an unknown code with `UnknownDictCodeError` (opt-out-able) |
| `StaticDictReadonlyError` distinct from existing dict errors | ✓ | thrown on any mutation attempt against a static name |
| Subsystem-doc update + showcase + `features.yaml` invariants | ✓ | reader-facing; honorific/civil-status end-to-end, incl. a **locale-less** read assertion |

## v1 SCOPE — what's deferred / out

| Feature | Status | Why |
|---|---|---|
| Large *external* reference datasets (TSIC, DOPA address tree, ISO country list) | **out** | domain data, not closed app enums — stay app-side reference tables (explicit non-goal in #291) |
| Per-vault **override** of a static label | deferred | breaks "identical across vaults by construction"; would reintroduce `_dict_*`. Separate slice if ever needed. |
| `displayLocale` as a per-read default rather than per-descriptor | deferred | descriptor-level is simplest and matches the consumer; a read-option default can layer on later |
| Hot-reloading the table at runtime | out | a label change is a code deploy by definition |
| Per-layer `onMissing` (guard/mv/derivation/join/export) for static dicts | follows #285 | the broader per-layer wiring is already deferred for `dictKey`; static inherits whatever lands there |

## Wiring — the two seams (concrete)

Embedding touches **two** label-resolution mechanisms; they are separate and both must be wired.

### Seam 1 — read path (live resolver)

`vault.ts:752-758` currently builds one closure for all dict fields. Branch on descriptor brand:

```ts
collOpts.dictLabelResolver = async (dictName, key, locale, fallback) => {
  const stat = staticByName.get(dictName)          // descriptors with _noydbStaticDict
  if (stat) {
    const labels = stat.table[key]
    return labels ? resolveFromMap(labels, locale, fallback) : undefined
  }
  return this.dictionary(dictName).resolveLabel(key, locale, fallback) // unchanged dictKey path
}
```

The hybrid hinge is the **gate** at `collection.ts:3038-3043`. Today there are **two** sequential early-returns:

```ts
const hasI18n = this.i18nFields && Object.keys(this.i18nFields).length > 0
const hasDict = this.dictKeyFields && Object.keys(this.dictKeyFields).length > 0
if (!hasI18n && !hasDict) return record   // 3040 — nothing to resolve
const locale = localeOpts?.locale ?? this.defaultLocale
if (!locale) return record                // 3043 — locale-less ⇒ raw record (today's invariant)
```

Only the **second** return relaxes; the first (`3040`) stays verbatim. ⚠️ Do **not** fold `hasI18n` into the second return — that would let an i18nText-only collection fall through to `applyI18nLocale(..., undefined)` on a locale-less read, breaking the consumer's bare-`{th,en}`-map invariant (the very property this feature must preserve). Correct shape:

```ts
if (!hasI18n && !hasDict) return record               // 3040 — UNCHANGED
const locale = localeOpts?.locale ?? this.defaultLocale
const hasStaticDisplay = /* any static descriptor in this.dictKeyFields with displayLocale */
if (!locale && !hasStaticDisplay) return record       // only static-display proceeds locale-less

// The i18n sub-block (3048) MUST now be locale-guarded, because the relaxed gate
// can be passed with locale === undefined when hasStaticDisplay:
if (locale && hasI18n && this.i18nFields) { /* applyI18nLocale — unchanged */ }

// dictKey/static sub-block (3053): per-field effLocale = locale ?? desc.displayLocale.
//  - static field w/ displayLocale → resolves locale-lessly
//  - plain dictKey field (no displayLocale) → effLocale undefined → resolver returns
//    undefined → onMissing 'null' (default) omits the label, exactly as today.
```

Locking tests to keep / add:
- `dictionary.test.ts:350-367` (plain `dictKey`, no `displayLocale`) — still returns the raw record locale-less. ✓ unchanged.
- **NEW**: an `i18nText`-only collection on a locale-less vault still returns the raw `{th,en}` map — a direct regression guard for this gate edit. The existing dictKey test does **not** cover the i18n path, so this guard is mandatory.
- **NEW**: a `staticDict` with `displayLocale` resolves `<field>Label` locale-less; the same descriptor without `displayLocale` does not.

### Seam 2 — query path (snapshot resolver)

`query/builder.ts:1271` `buildDictLabelResolver` reads `joinCtx.resolveDictSource(field)` → `dictSource.snapshot()` (today: a snapshot of the `_dict_*` collection). A static dict has no `_dict_*`. So `resolveDictSource` returns a **code-table-backed source** whose `snapshot()` yields `[{ key, labels }]` materialised from `desc.table`. `buildDictLabelResolver` then works **unchanged**. For a locale-less `{ by: 'label' }` query, the query locale defaults to the field's `displayLocale`.

## Errors

| Error | When | Distinct from |
|---|---|---|
| `StaticDictReadonlyError` | `put`/`rename`/`delete` against a static dict name | a static dict has no mutation surface |
| `UnknownDictCodeError` | put-time: record stores a code not in `desc.keys` (opt-out-able) | `LocaleNotSpecifiedError` (read-hole) — this is a write-shape error |

`LocaleNotSpecifiedError` is still raised by `onMissing:'throw'` when a code resolves to no label in the effective locale (unchanged policy).

## Behavior matrix

| Read | plain `dictKey` (today) | `staticDict` w/ `displayLocale:'th'` |
|---|---|---|
| locale-less vault, bare `get` | raw code, **no** `…Label` | code **+** `…Label` (via `displayLocale`) |
| `get({ locale:'en' })` | `…Label` from `_dict_*` | `…Label` from code table |
| `get({ locale:'raw' })` | raw (block skipped, `collection.ts:3053`) | raw (same) |
| `groupBy(field)` | by code | by code |
| `orderBy(field,{by:'label'})` | by `_dict_*` label @ locale | by code-table label @ locale ?? `displayLocale` |

## Tree-shake / registry / showcase

- All new code inside `withI18n()` / `i18n/*`; `NO_I18N` stub path unaffected; bundle gate unchanged.
- **`features.yaml`** (the `i18n` entry, lines 318-344) MUST gain invariants, or the "Spec coverage" CI job fails on dangling refs. Proposed:
  - `staticDict(name, table, {displayLocale}) resolves labels from an in-code table — no _dict_* collection, no rename()`
  - `static dicts resolve under a locale-less read via displayLocale; plain dictKey does not (locale gate preserved)`
  - `static dict names are read-only: put/rename/delete throw StaticDictReadonlyError`
- New showcase (e.g. `96-with-static-dict.showcase.test.ts`) asserting: locale-less resolution via `displayLocale`, locale-active resolution, `groupBy by:'key'`, absence of any `_dict_*` adapter key, and `StaticDictReadonlyError` on mutation.

## Worked trace (acceptance)

1. `vault = openVault('co1')` — **no** locale.
2. `collection('workers', { dictKeyFields: { civilStatus: staticDict('civilStatus', TABLE, { displayLocale:'th' }) } })`.
3. `put({ id:'w1', civilStatus:'adultMale' })` — record stores only the code; no `_dict_civilStatus` key created.
4. `get('w1')` → `{ id:'w1', civilStatus:'adultMale', civilStatusLabel:'นาย' }` (gate not early-returned; static branch uses `displayLocale`).
5. `get('w1', { locale:'en' })` → `civilStatusLabel:'Mr'`.
6. `query().orderBy('civilStatus', { by:'label' })` → sorts by label at the active locale, else `displayLocale`.
7. `vault.dictionary('civilStatus').put(...)` → throws `StaticDictReadonlyError`.

## Open decisions (for the plan)

- **Validation default:** is `UnknownDictCodeError` on at write by default, or opt-in? Lean **on** (codes are closed by construction; a typo is a bug). Provide `validateCodes: false` escape hatch.
- **`displayLocale` required?** If omitted, a static dict behaves like `dictKey` under a locale-less read (no label). Lean **optional** — omit ⇒ pure parity; set ⇒ hybrid. Document that a locale-less consumer almost always wants it set.
- **Naming:** `staticDict` vs `codeDict`. `staticDict` matches the userland workaround and the issue title.

## Milestone

Attach #291 to **milestone #17** (i18n hardening). Sequence after the shipped #282/#283 parity (#284); independent of the deferred per-layer enforcement (#285). Estimated as one slice: descriptor + dual-seam wiring + readonly guard + showcase + `features.yaml` + subsystem-doc.
