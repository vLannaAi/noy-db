# Forking the enclave

> **Audience:** a sister project (e.g. `nit-db`) that wants noy-db's spine,
> services, and wire protocol, but its own crypto engine, in-memory
> protection policy, or key story.
>
> **Companion docs:** `docs/superpowers/specs/2026-07-03-enclave-contract-v1-design.md`
> (the design — read it first for the *why*), `SPEC.md` → "Crypto invariants",
> `docs/core/02-encryption.md` (the reference enclave's own behavior).

## What a fork replaces

**Exactly one folder: `packages/hub/src/kernel/enclave/` — nothing else.**
That folder is noy-db's crypto interior:

- `crypto.ts` — the Web Crypto primitives (AES-256-GCM, PBKDF2-SHA256,
  AES-KW, HKDF, SHA-256/HMAC-SHA-256).
- `record-keys/` — the per-record codec, sealing, deterministic-encryption,
  tombstone, and envelope-body-access engines built on top of those
  primitives.
- `index.ts` — the barrel: the **only** file the rest of the hub is allowed
  to import from this folder (`scripts/check-architecture.mjs`'s
  `enclave-barrel-only` check enforces that mechanically).

A fork deletes this folder and drops in its own implementation — a
different KDF, a hardware-backed keystore, a post-quantum wrap algorithm, a
keyless HSM-backed design — as long as the replacement re-exports the same
barrel (below). Nothing outside `kernel/enclave/**` needs to change, and
`kernel/enclave/**` itself imports nothing from `with-*` services (the C3
self-containment guarantee, also architecture-checked), so there's no
tangle to unwind on the way out.

## What a fork keeps

Everything outside `kernel/enclave/**` is family-owned and untouched by a
fork:

- **The envelope protocol header** — `_noydb`, `_v`, `_ts`, `_by`,
  `_source`, `_sourceTs`, `_tier`, `_elevatedBy`. This is wire protocol, not
  protection: stores, the sync engine, history, and klum's cross-vault
  orchestration all read these fields directly, on every enclave. Only the
  **protected body** (`_iv`, `_data`, `_cek`, `_det`, `_sealed`, `_debug`)
  is enclave territory (see "The ratchet" below) — a fork's enclave owns
  those fields' meaning, the header's meaning is fixed by the family.
- **The spine** — `Noydb` → `openVault()` → `Vault` → `vault.collection<T>()`
  → `Collection`, the owner keyring, schema/refs, basic query.
- **The services** — every `with-*` subsystem (history, blobs, sync,
  aggregate, crdt, team, …) and its `with<Name>()` strategy seam.
- **The ports** — `to-*` storage destinations, `in-*` framework bindings,
  `on-*` unlock primitives, `as-*` export formats, `by-*` transports,
  `at-*` sealing-key providers. None of these see plaintext or the
  protected body directly; they call through the collection/vault API or
  (for `to-*`) receive ciphertext envelopes verbatim.

## The contract surface

`kernel/enclave/index.ts` is the frozen barrel — every symbol below must
exist in any fork's replacement folder, with the same name and shape.
Frozen by `packages/hub/__tests__/enclave-surface-golden.test.ts` against
`enclave-surface.golden.json` (40 value exports + 4 type exports today).
**Additive changes only** — the family can add a new export in a later
release; removing or renaming one is breaking for every fork.

- **Key type** — `EnclaveKey` (`= CryptoKey` in the reference enclave). The
  opaque handle every barrel-facing signature traffics in. A fork
  redefines the alias to its own representation (`type EnclaveKey = null`
  for a keyless design) and the spine type-checks against that keyless
  world at fork-compile time — outside the enclave, `EnclaveKey` is never
  constructed, inspected, or serialized, only passed between barrel calls.
- **Crypto ops** — `encrypt`/`decrypt` (+ `Bytes`, `BytesWithAAD`,
  `Deterministic` variants), `sha256Hex`, `hmacSha256Hex`.
- **Key lifecycle** — `deriveKey`/`derivePassphraseKey` (PBKDF2-SHA256 →
  AES-KW / AES-GCM), `generateDEK`, `wrapKey`/`unwrapKey`,
  `wrapCek`/`unwrapCek`/`importCek`, `derivePresenceKey`,
  `deriveSealedFieldKey`/`deriveSealedFieldKeyFromCek`,
  `resolveStableCek`/`rewrapBodyToDek`, base64 helpers, IV/salt generators.
- **Record codec** — `RecordCodec`, the per-record encode/decode engine.
- **Sealing** — `sealRecordToHost`/`revokeSealedRecord`/`rotateRecordCek`,
  `SealingContext`.
- **Deterministic** — `findByDet`/`queryByDet`, `DeterministicContext`.
- **Tombstone** — `isTombstone`/`buildTombstone`.
- **Envelope body (the C1 protected-body access contract)** — the **4 body
  helpers**, the sanctioned door onto `_iv`/`_data`/`_cek`/`_sealed` for
  everyone outside the folder:
  - `openEnvelopeJson(env, key): Promise<string>` — decrypt (or pass
    through, in plaintext mode) the body to its JSON text.
  - `writeEnvelopeBody(json, key, opts): Promise<BodyFields>` — produce the
    protected-body fields for callers assembling envelopes.
  - `hasPerRecordKey(env): boolean` — `_cek !== undefined`, without the
    caller touching `_cek` itself.
  - `envelopeBodyForHash(env): string` — canonical body-bytes accessor for
    the ledger hash chain.

### Refusal semantics — `EnclaveNotSupportedError`

The barrel is frozen, but three groups are **optional**: `sealing`,
`deterministic`, and per-record-key lifecycle (`wrapCek`/`unwrapCek`). A
fork whose enclave doesn't implement one of these may throw
`EnclaveNotSupportedError(group, detail?)` (`code: 'ENCLAVE_NOT_SUPPORTED'`,
`kernel/errors.ts`) from **every** function in that group. The services
that call them (`sealed-record`, `tiers`, deterministic queries) surface
the error verbatim rather than swallowing it.

Two hard rules:

1. **Never a mix.** A group either fully works or fully refuses. A fork
   whose `deriveSealedFieldKey` refuses but whose `deriveSealedFieldKeyFromCek`
   silently succeeds is non-conformant — see the conformance kit below,
   which exists specifically to catch this.
2. **The core groups must never throw it.** Crypto ops, the record codec,
   and tombstone semantics are unconditional — every fork must implement
   them for real. `EnclaveNotSupportedError` is a lever for the three
   optional groups only, never a way to skip the core contract.

A service that receives `EnclaveNotSupportedError` must **fail closed** —
treat it as "this operation is refused," never as "no protection was
necessary." Silently proceeding as if the optional group succeeded would
be a data-protection regression, not a graceful degradation.

## Running the conformance kit

`test-harnesses/enclave-conformance/` is the contract as an executable
spec — the enclave equivalent of `test-harnesses/adapter-conformance`.
Point it at any enclave module (the reference one, or a fork's):

```ts
import { runEnclaveConformance } from '@noy-db/test-enclave-conformance'
import * as enclave from './my-fork/kernel/enclave/index.js'

runEnclaveConformance(enclave, {
  supports: { sealing: true, deterministic: true, perRecordKeys: false },
})
```

Set each `supports.*` flag to whether your enclave implements that optional
group. The kit then verifies, in one pass:

- envelope body round-trip (write → open → identical JSON; header
  untouched),
- tombstone semantics (`buildTombstone` → `isTombstone` true; live
  envelopes false; plaintext-mode behavior),
- key lifecycle coherence (`deriveKey` → `wrapKey` → `unwrapKey` round
  trip),
- **group-consistency** for each optional group — every function in the
  group works, or every function refuses via `EnclaveNotSupportedError`;
  a mixed group fails the suite (see `assertGroupRefuses` in
  `test-harnesses/enclave-conformance/src/index.ts`, and
  `self-test.test.ts`, which proves the checker itself catches a
  deliberately mixed stub),
- determinism where claimed (`encryptDeterministic` is stable for the same
  input),
- no protected-body-field leaks in helper outputs, and
- (when `supports.sealing`) known-answer test vectors decrypt correctly —
  useful if your fork claims wire-compatibility with noy-db's own codec.

**4 documented coverage omissions:** `resolveStableCek`, `rewrapBodyToDek`,
`findByDet`, and `queryByDet` take a collection-shaped context object
(`StableCekDeps` / `DeterministicContext`) rather than the plain key/envelope
arguments a generic kit can construct portably. The kit exercises their
lower-level primitives instead (`wrapCek`/`unwrapCek`,
`encryptDeterministic`/`decryptDeterministic`) — a fork's implementation of
those four functions is not independently conformance-checked today.

noy-db runs the kit in CI against its own reference enclave
(`test-harnesses/enclave-conformance/src/conformance.test.ts`), proving the
kit against a known-good implementation before any fork relies on it.

## Security expectations

A fork's enclave inherits these expectations from the reference
implementation — they are the contract's security floor, not
implementation details a fork is free to relax:

- **Fail closed.** `EnclaveNotSupportedError` on an optional group must
  stop the operation, not silently downgrade to "unprotected." Zero npm
  crypto dependencies (`crypto.subtle` only) and no Node-only imports
  (`kernel/enclave/**` must stay portable to browser/Worker/Deno/Bun) are
  both mechanically enforced for the reference enclave and are strongly
  recommended defaults for a fork.
- **Sealed non-residency.** Sealed fields (`_sealed[field]`) must never be
  materialized into the plain working set by a barrel helper — no helper
  returns key material, and `openEnvelopeJson`/`writeEnvelopeBody` operate
  only on the fields they're contracted to touch.
- **`forget()` RAM-scrub.** `vault.forget()` (GDPR crypto-shred) drops the
  wrapped keys that make a subject's data recoverable; live in-memory
  caches (DEKs, vault instance, active tier) are scrubbed as part of the
  same call. A fork's key-lifecycle functions must preserve this: once a
  key is dropped, nothing in the enclave should be able to reconstruct it
  from residual state.
  *(Known pre-existing quirk, not fork-specific: on a plaintext vault
  (`encrypt: false`), `forget()`'s idempotency behavior is a documented
  wrinkle — re-running `forget()` for an already-forgotten subject on a
  plaintext vault behaves consistently across the record and history
  layers as of Enclave Contract v1, but was never made fully idempotent in
  the original design. See issue #551's closing notes.)*

## The ratchet — `enclave-body-only`

C1 split the envelope into the protocol header (above) and the protected
body, but **121 direct body-field accesses across ~55 non-enclave files**
predated that split (2026-07-03 audit) — too many to migrate in one pass.
`scripts/check-architecture.mjs`'s `enclave-body-only` check is a
**ratchet, not a hard ban**: each offending file is grandfathered in the
`PRE_EXISTING_BODY_ACCESS` map at its scanned count. The rule is exact
equality — a file's actual count must always match its grandfathered
entry; raising it fails CI, lowering it without updating the map also
fails CI (the map has to be edited to bank a real reduction). The map
reaching empty is the definition of "C1 done."

**Current remaining count: 266 direct accesses across 51 files** (down
from the original 337 across 53 — Enclave Contract v1's Tasks 6–7 migrated
the highest-traffic sites: `hash.ts`'s body computation, discriminant
checks, and several dozen `decrypt(env._iv, …)` call sites onto the 4 body
helpers).

This ratchet is a fork's friend, not its problem: every grandfathered site
that shrinks is a call site that stopped assuming the envelope body's
literal shape and started going through `openEnvelopeJson` /
`writeEnvelopeBody` / `hasPerRecordKey` / `envelopeBodyForHash` instead —
one fewer place a fork's own enclave has to structurally match the
reference implementation's `_iv`/`_data`/`_cek`/`_sealed` layout. A fork
doesn't need to wait for the ratchet to reach zero to fork today (the
barrel contract is what's frozen, not the migration's completion), but a
smaller grandfather map means less code implicitly assumes noy-db's
specific envelope shape.
