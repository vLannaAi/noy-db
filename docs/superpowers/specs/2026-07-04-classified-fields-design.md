# Classified fields — behavioral sensitive-field types (design)

**Date:** 2026-07-04 · **Status:** DRAFT — pending owner review
**Origin:** brainstorm following pilot-3 closeout (#484/#485/#486 shipped; #489 open)
**Related:** field-metadata RFC (#483), record-scoped sealing (#306, `2026-06-29-306-record-scoped-sealing.md`), Enclave Contract v1 (`2026-07-03-enclave-contract-v1-design.md`), service-layer withX archetypes (`2026-07-01-service-layer-withx-design.md`)

## Problem

`sensitivity: 'pii' | 'secret'` (shipped in the field-metadata epic) is *descriptive* — a tag
consumers read. Every behavior it implies still lives in userland: apps decrypt a credit card
into browser memory, then truncate it themselves for display, compare it in non-constant time,
or store a CVC they were never allowed to persist. That userland is the bug surface.

This design makes sensitive fields *behavioral field kinds* — the same leap `money()` made over
"a number with a label". Each classified type carries a capability profile; every operation that
touches the raw value runs inside the enclave; only three things cross the boundary:

1. **verdicts** — booleans from verify/match operations,
2. **sanctioned projections** — masks and write-time-derived rider fields,
3. **audited single-point reveals**.

At-rest protection is out of scope: everything is already AES-256-GCM encrypted before any store
sees it. This layer governs (a) what enters the envelope as companions and (b) what leaves the
enclave as output.

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Anchor = enforcement (both PII-display and verify-without-reveal worlds, unified) | owner (2026-07-04 brainstorm) |
| D2 | v1 extensibility = presets + declarative knobs only; composition vocabulary stays internal | owner |
| D3 | **Open-on-write, declarative-on-read**: custom validators/riders (write-side) allowed — userland already holds what it writes; read-side behavior is a closed vocabulary the enclave executes; no read-side callbacks | design law |
| D4 | Naming: `classifiedFields` config key, `classified.*` preset namespace | ASSUMED (recommended default; owner may rename) |
| D5 | Two-stage delivery: stage 1 display/redaction (no new crypto), stage 2 enclave oracle (own security cycle) | ASSUMED |
| D6 | Oracle + reveal ops gated behind `withClassified()` (② archetype, pre-1.0 breaking per convention) | ASSUMED — needs explicit owner OK |
| D7 | Presets live hub-common (a `with-*` service); only crypto primitives live in `kernel/enclave` behind the frozen barrel; forks extend by composing the same primitives, noy-db stays regime-unaware | ASSUMED |

## Surface

```ts
vault.collection<User>('users', {
  classifiedFields: {
    pin:  classified.password({ minLength: 12, rotateDays: 90, notLastN: 5 }), // stage 2
    card: classified.creditCard({ pan: 'cardNumber', expiry: 'cardExpiry', cvc: 'cardCvc' }),
    dob:  classified.birthDate(),
    mail: classified.email(),
  },
})
```

- Declaration is a **③ schema feature** (like `moneyFields`/`dictKeyFields`): no withX needed to
  declare; masking/projection metadata always flows to `describe()`.
- Ops (`reveal`, stage-2 `verify`/`matchGroup`) require `withClassified()`; without it they throw
  `ClassifiedNotEnabledError` and tree-shake out (② archetype).

### Capability axes (what a preset bundles)

| Axis | Values | Notes |
|---|---|---|
| storage | `recoverable` (sealed, #306) · `digest-only` (stage 2) · `dual` (stage 2) · `never` | `never` ⇒ a write containing the field **throws** (fail-loud) |
| list projection | `omit` · `mask(pattern)` · `rider(name)` | what queries/exports emit |
| riders | preset-owned write-time transforms → ordinary sibling fields | reuses computed-fields machinery; default name `<field>_<rider>` |
| write validation | preset (Luhn, ISO-date, complexity) + custom app validators | write-side is open (D3) |
| verify (stage 2) | `equals` (digest) · `text` (decrypt-in-enclave) · `group` (k-of-n) | verdict-only egress |
| normalize | per-type canonicalization (NFC/casefold/trim; PAN strip; date ISO) | most "fuzziness" is normalization; edit-distance matching explicitly OUT |
| lifecycle | forget() shreds digests too; rotation ring (stage 2) | |

### Preset catalog (v1)

| Preset | Storage | List | Riders | Verify (stage 2) | Notes |
|---|---|---|---|---|---|
| `creditCard()` | pan: recoverable→dual · expiry: recoverable · cvc: **never** | `•••• ${last4}` | `last4`, `bin`, `expiresSoon` | equals (normalized PAN) | composite; CVC persistence is unrepresentable (PCI-aware) |
| `birthDate()` | recoverable | `yyyy-••-••` | `ageBand` | equals | low-entropy candor in docs |
| `email()` / `phone()` | recoverable | partial mask | `domain` / `last2` | equals | |
| `password()` | digest-only (PBKDF2-600K, per-record salt) | omit | — | equals + `mustRotate` verdict | stage 2 only; reveal is a compile error |
| `secretAnswer()` | digest-only, aggressive normalize | omit | — | equals, groupable k-of-n | stage 2 only |

Composite types map **member roles to record fields** (see `creditCard` above) with differential
per-member policy.

## Read path

- `get()`/queries return projections; recoverable classified fields surface as sealed handles
  (existing `Sealed<V>`), never inline plaintext.
- `reveal(id, field)` — one field, one record, one decrypt; emits a deed-audit event when the
  audit service is on; refused **at compile time** for digest-only presets (extend the S/Q/M
  phantom-generic refusal pattern). Future hook (reserved, not v1): require a fresh `on-*`
  step-up assertion before reveal.
- Classified fields join the `S` refusal set automatically — declare once, the query DSL
  refusal matrix follows.

## Write path

- Riders + digests minted inside the hub before encryption (write-side already holds plaintext —
  no new exposure).
- Digest companions (stage 2) are **keyed**: HMAC under an HKDF-derived per-collection classify
  index key — never the collection DEK (L-1 lesson), never bare sha256 (a bare hash in the
  envelope would let the store dictionary-attack low-entropy fields, violating zero-knowledge).
  External digests (interop) come **in as candidates only**, are compared inside the enclave,
  and are never persisted.
- `storage: 'never'` members are validated then rejected from persistence (throw, not strip).

## Stage split

**Stage 1 — display & redaction (no new cryptography):**
descriptors + presets (creditCard/birthDate/email/phone), riders via computed-fields, list
projections, `reveal` (existing unseal machinery + audit), `withClassified()` gate,
`x-classified` emission in `describe()`/`toJSONSchema()`, and a single shared
`applyListProjection()` helper consumed by all `as-*` exporters — **this closes #489** with one
vetted implementation instead of per-exporter redaction logic.

**Stage 2 — the enclave oracle (own design→security-audit cycle):**
enclave primitives (normalize-digest, constant-time compare, k-of-n evaluator) added to
`kernel/enclave/` behind the frozen Contract v1 barrel (additive only); `password()` /
`secretAnswer()`; `verify`/`verifyText`; `matchGroup(id, answers, { min: k })` evaluating ALL
members without short-circuit and returning only the aggregate verdict (per-member results would
decompose a k-of-n challenge into independent single oracles); digest-history ring powering
`rotateDays`/`notLastN` and `{ ok, mustRotate }` verdicts; `enclave-body-only` ratchet extended
so "classified plaintext appears only in enclave modules" is CI-enforced.

## Threat model (honest claims)

- **Software boundary, not hardware.** The enclave is JS in the same process; decrypted bytes are
  ordinary memory. A fully compromised client (XSS) can call oracle APIs like any caller.
- What the layer delivers: structural elimination of *accidental* exposure (logs, devtools,
  state stores, naive truncation); microsecond plaintext windows instead of plaintext living in
  app state; *deliberate* access made loud (deed audit) and rate-limitable.
- **Oracle abuse:** verify() is an online guessing surface. Low-entropy types (blood group: 8
  values; birth dates: ~30k) fall to enumeration regardless of crypto — preset docs state this;
  the defense is audit + rate hooks, not the digest.
- **Frequency leakage:** equality-matchable digests (`dual`, stage 2 `findByDigest`) reveal
  value-cluster structure to the store even when keyed — opt-in per field, following the M-2
  HMAC(indexKey)+padding precedent.
- Claim language: "PCI-aware defaults, exposure minimization, audited egress" — never
  "hardware-enclave security" or compliance guarantees.

## Non-goals

- Typo-tolerant / edit-distance matching on encrypted values (n-gram digest sets leak; secure
  sketches exotic). Normalization is the sanctioned fuzziness.
- Logging/telemetry redaction (app-side, per #486 scope note).
- Public `classified.custom()` composition API (post-v1, informed by preset usage).
- Any change to at-rest encryption or envelope crypto.

## Testing

- TDD throughout; per-preset behavior suites (projection, refusal, rider materialization,
  `storage:'never'` rejection).
- Stage 2: enclave-conformance kit gains classified-primitive vectors; adversarial tests for
  verdict-only egress (no per-member leak from matchGroup, constant-time compare sanity).
- Arch guards: `strategy-opt-in` covers `withClassified()`; `enclave-body-only` ratchet extended
  (stage 2); golden surfaces (kernel API, enclave barrel) updated additively.
- Full cross-package suite for the gate introduction (② gates are cross-package breaking — the
  diffVault lesson).

## Open questions for owner

1. Confirm/veto the four ASSUMED decisions (D4 naming, D5 staging, D6 gate, D7 fork seam).
2. Rider field naming: `<field>_<rider>` default OK? Collision policy with declared fields
   (proposal: throw at collection() time).
3. Composite declaration shape: roles-to-fields map (as specced) vs per-field presets + group ref.
4. Does stage 1 land as one PR-arc on the 0.3 line, and does #489 close inside it or stay a
   separate as-* PR consuming the helper?
