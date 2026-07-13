# Classified fields — the `classified` via-feature

Classified fields declare PII/secret-grade values with per-preset validation, storage semantics,
and list-view redaction. Since #629 (phase B) classified is a **via-feature** (`_viaBrand:
'classified'`): declaring a field seals it at rest through the same kernel-orchestrated pipeline
money and i18n use, refuses non-conforming writes before they reach the store, and participates in
the query/export/forget posture enforcement every via-feature now gets for free (see
[`docs/subsystems/via.md`](via.md)).

Enable the feature with `classifiedStrategy: withClassified()` (subpath `@noy-db/hub/classified`);
without it, classified fields still write/read but `.reveal()`/`.verify()` throw
`ClassifiedNotEnabledError`.

## Declaring fields — the preset catalog

There is no `via(classified())` composer form yet (see the caveat in [`via.md`](via.md)) —
declare classified fields under the `classifiedFields` collection option, using the `classified`
preset namespace (`@noy-db/hub` root export):

```ts
import { createNoydb, classified } from '@noy-db/hub'
import { withClassified } from '@noy-db/hub/classified'

const db = await createNoydb({ user: 'a', secret: 'pw', classifiedStrategy: withClassified() })
const v = await db.openVault('v1')
const cards = v.collection('cards', {
  classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
})

await cards.put('r1', { pan: '4242424242424242' })
```

(from `packages/hub/__tests__/classified/reveal-gate.test.ts`, `packages/hub/__tests__/classified/read-path-id-threading.test.ts`).
`classified.creditCard(...)` returns a *group* (multiple member fields) — the `classifiedFields`
map key (`card` above) is just its declaration site; the record fields it actually touches are
named by its own arguments (`pan`, `cvc`). A single-field preset (`email()`, `birthDate()`,
`phone()`, `password()`, `secretAnswer()`) has no such indirection — the `classifiedFields` map
key IS the record field name, e.g. `classifiedFields: { email: classified.email() }`.

Presets (`packages/hub/src/via/classified/presets.ts`):

| Preset | Storage | Notes |
|---|---|---|
| `classified.creditCard({ pan, expiry?, cvc? })` | pan/expiry: `recoverable`; cvc: `never` | Luhn-validated PAN; CVC is rejected if a write ever carries a value (PCI-aware) |
| `classified.birthDate()` | `recoverable` | ISO `yyyy-mm-dd`, calendar-validated |
| `classified.email()` | `recoverable` | basic `@` validation |
| `classified.phone()` | `recoverable` | digit-count validation |
| `classified.password({ minLength?, rotateDays?, notLastN?, equatable? })` | `digest-only` | verify-without-reveal; never listed |
| `classified.secretAnswer({ equatable? })` | `digest-only` | normalized (casefold/trim/collapse); k-of-n `matchGroup` |

**Storage semantics** (`ClassifiedFieldSpec.storage`) drive everything downstream:

- `'recoverable'` — sealed into its own encrypted slot (`_sealed[field]`); readable via `.reveal()`
  or, once opted into `equatable`/queried, digest paths. This is the set the via binding's
  `encodeAtRest`/`decodeAtRest` hooks seal (see Architecture below).
- `'digest-only'` (passwords, secret answers) — never stored recoverable; only a verification
  digest (and, opt-in via `equatable: true`, a store-visible `_bidx` equality tag — see the
  preset doc comments for the offline-attack cost band before enabling it).
- `'never'` (credit-card CVC) — a write carrying any value for this field is rejected outright
  (`ClassifiedNeverStoredError`), before either at-rest hook runs.

A field failing preset validation (e.g. a non-Luhn PAN) throws `ClassifiedValidationError`; an
illegal collection/guard combination (e.g. a `digest-only` field without `perRecordKeys: true`)
throws `ClassifiedConfigError` at collection-construction time.

## Reading — `SealedHandle` by default, `.reveal()` to unseal

A `'recoverable'` field reads back as an opaque `SealedHandle`, not the plaintext — it never
leaks via `JSON.stringify` (`SealedHandle.toJSON()` returns the literal string `'[sealed]'`).
Call `.reveal()` on the handle, or `collection.reveal(id, field)`, to get the plaintext:

```ts
await cards.put('r1', { pan: '4242424242424242' })   // no cvc value — 'never' rejects a write that carries one
await expect(cards.reveal('r1', 'pan')).resolves.toBe('4242424242424242')
await expect(cards.reveal('r1', 'cvc')).rejects.toThrow(/never/)      // nothing was ever stored
```

(from `packages/hub/__tests__/classified/reveal-gate.test.ts`). This reveal/verify layer
(`.reveal()`, `.verify()`, `.verifyGroup()`, `.findByDigest()`) pre-dates phase B and is
unaffected by it — every read path round-trips a sealed field correctly through the phase-B `via`
cutover: `collection.ts`'s own surface (`get`, `listPage`, `scan`, `history`, `getVersion`, the
`beforePut` gate's prior-record view — `packages/hub/__tests__/classified/read-path-id-threading.test.ts`)
and the five out-of-`collection.ts` consumers of `RecordCodec.decryptRecord` (`findByDet`,
`queryByDet`, `getAtTier`'s tier-0 branch, `rebuildIndexes`, `reconcileIndex` — missed by the same
Task-6 id-threading pass and fixed in the whole-branch review's cross-feature wave,
`packages/hub/__tests__/classified/cross-feature-id-threading.test.ts`).

## Query posture — `det-exact`: silent no-match, not a throw

Classified's `ViaPosture.queryable` is `'det-exact'`. This is **parity-preserving, not a new
refusal**: `.where()`/`.orderBy()`/`.aggregate()` over a classified field do not throw — they
silently don't match / don't meaningfully order, exactly as before phase B, because a
`SealedHandle` isn't comparable to a raw query value:

```ts
const res = await cards.query().where('pan', '==', '4242424242424242').toArray()
expect(res).toEqual([])   // SealedHandle !== raw value — same behavior pre- and post-#629
```

(from `packages/hub/__tests__/via/query-posture-b.test.ts`). The real equality path for an
`equatable: true` digest-only field is `collection.findByDigest(field, candidate)` (the `_bidx`
blind-index lookup), unaffected by the flip:

```ts
const users = v.collection('users', {
  perRecordKeys: true, acknowledgeEquatableRisk: true,
  classifiedFields: { password: classified.password({ equatable: true }) },
})
await users.put('r1', { password: 'supersecret1' })
expect(await users.findByDigest('password', 'supersecret1')).toEqual(['r1'])
```

(from `packages/hub/__tests__/via/query-posture-b.test.ts`, `PARITY: det-exact routes to the
existing _bidx equality path`). Only `via-blob`'s `queryable: 'none'` posture gets a *new*
`FieldNotQueryableError` refusal in phase B — see [`via-blob.md`](via-blob.md).

## Export posture — deliberate `'[sealed]'` redaction

Classified's `ViaPosture.exportable` is `false`. `Vault.exportStream()`/`exportJSON()` now
deliberately redact a covered field to the literal string `'[sealed]'` **on the record itself**
before it ever reaches a stream consumer — not just as a side effect of `JSON.stringify`ing a
`SealedHandle`:

```ts
const chunks: { collection: string; records: unknown[] }[] = []
for await (const chunk of v.exportStream()) chunks.push(chunk)
const rec = chunks.find((c) => c.collection === 'cards')!.records[0] as { pan: unknown }
expect(rec.pan).toBe('[sealed]')   // EXPORT_REDACTION_MARKER
expect(rec.pan).not.toBeInstanceOf(SealedHandle)
```

(from `packages/hub/__tests__/via/export-posture-b.test.ts`). `SealedHandle.toJSON()` itself is
untouched and still independently returns `'[sealed]'` for any consumer that bypasses
`exportStream()` (e.g. a raw `collection.get()` read that gets `JSON.stringify`'d) — belt and
braces, both layers verified independently in the same test file.

This changed the **default** (non-`redact`-option) output of the `as-csv`/`as-sql`/`as-xml`
satellite exporters for a classified field: pre-#629 they saw a live `SealedHandle` object and
fell through to `JSON.stringify`-based formatting (`"""[sealed]"""` in CSV, a `jsonb` column with
literal `'"[sealed]"'` in SQL); post-#629 they see the plain string `'[sealed]'` directly (a bare
`[sealed]` CSV cell, a `text` SQL column with literal `'[sealed]'`). See
`packages/as-csv/__tests__/default-export-redaction.test.ts`,
`packages/as-sql/__tests__/default-export-redaction.test.ts`,
`packages/as-xml/__tests__/default-export-redaction.test.ts`.

## Forget / erasure

Classified's `ViaPosture.forgettable` is `true`. `vault.forget()` now consults this and, for a
collection with a `classifiedFields` binding compiled in, routes sealed-slot classification
through the via `erase()` hook instead of the pre-#629 hand-rolled path:

```ts
// createNoydb({ ..., forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }) })
const vault = await db.openVault('v')
const people = vault.collection('people', {
  perRecordKeys: true,
  classifiedFields: { email: classified.email() },
})
await people.put('p1', { id: 'p1', subjectId: 'subject-1', email: 'ada@example.com' })

const result = await vault.forget('subject-1')
expect(result.sealedFieldsShredded).toBe(1)
expect(result.sealedResidue).toEqual([])
```

(from `packages/hub/__tests__/via/forget-classified-erase.test.ts`, using
`forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } })`). The reported counts
are byte-identical to the pre-#629 path for the same scenarios (a normally-written CEK-derived
slot is shredded; a legacy DEK-derived slot is reported as residue, not shredded) — this is a
parity guarantee, not new behavior.

**One piece stays vault-level and unconditional, by design:** the sealed-CEK
`_sealed_cek/<collection>/<id>/*` host-delivery envelope purge is proven (by the pre-existing
`forget-sealed-erasure.test.ts` H-1 suite) to run on *any* collection using `sealRecordToHost()`,
independent of whether it declares `classifiedFields` — a bare `sensitive: [...]` collection with
no classified binding at all gets this purge too. Routing it exclusively through the via `erase()`
hook would silently regress those undeclared collections, so `vault.forget()` keeps calling it
directly; the via binding's own `purgeSealedCekEnvelopes` closure exists and is unit-tested
(`packages/hub/__tests__/via/classified-binding.test.ts`) but is not wired into production. See
[`via.md`](via.md) (Phase B section) for the same note as it applies to blobs.

## Architecture

`classifiedBinding(cfg)` (`packages/hub/src/via/classified/binding.ts`) returns a
`ViaBinding` with `brand: 'classified'` and
`posture: { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }`.
`compileViaBindings` (`kernel/collection-config.ts`) compiles it in whenever a collection declares
`classifiedFields`, in the pinned stack order money → i18n → classified.

- `enforceWrite` runs the write-time preset validators + the `storage: 'never'` rejection (the
  existing `enforceClassifiedWrite` body) as the pipeline's write-enforcement phase.
- `encodeAtRest`/`decodeAtRest` seal/unseal every declared `'recoverable'` field — plus any bare
  `sensitive: [...]` field on the same collection, unioned in — through `ViaCryptoCtx.sealedSlots`,
  the kernel capability built in `kernel/enclave/record-keys/sealed-slots.ts`. Once this binding
  is compiled into a collection, its pipeline's `hasAtRestHooks` is `true` and the codec's
  legacy inline `sensitiveFields` seal path is retired for that collection — this is why bare
  `sensitive[]` fields are unioned in rather than left to the old path.
- `erase` classifies a live envelope's `_sealed` slots for shred-completeness (via a
  codec-provided closure, wired in `Collection`'s constructor) and marks each shreddable one
  deleted on the erase call's `sealedSlots` capability — see the "Forget / erasure" section above
  for what does and doesn't route through here.

`via-classified` never *statically* imports `kernel/enclave/` (`via-enclave-isolation`, enforced by
`pnpm check:architecture` with an **empty** allowlist as of #629 Task 4) — its `encodeAtRest`/
`decodeAtRest`/`erase` hooks reach their crypto through the injected `ViaCryptoCtx`. `active.ts`
(the opt-in `withClassified()` strategy — reveal/verify/verifyText/matchGroup/computeTarget) is the
one exception: it reaches the enclave through a `Check-13`-allowlisted (`enclave-classify-index-only`)
dynamic `import()` of `kernel/enclave/classify/*`, which the static `via-enclave-isolation` check
does not see.

## See also

- [`docs/subsystems/via.md`](via.md) — the Via port (field features, unified pipeline, phases)
- [`docs/subsystems/via-blob.md`](via-blob.md) — the sibling phase-B security feature
- `packages/hub/src/via/classified/` — presets, binding, descriptors, guards, errors
- `packages/hub/__tests__/classified/` — the pre-existing reveal/verify/digest suites
- `packages/hub/__tests__/via/classified-binding.test.ts`, `packages/hub/__tests__/via/query-posture-b.test.ts`, `packages/hub/__tests__/via/export-posture-b.test.ts`, `packages/hub/__tests__/via/forget-classified-erase.test.ts` — the phase-B binding/posture suites
