# Enclave Contract v1 — the fork-swap seam (#551)

> **Status:** design (2026-07-03), approved by owner. Follows the lexicon
> (`2026-07-01-noydb-architecture-lexicon.md`), the S5 door/port model
> (`2026-07-02-family-doors-kernel-diet-design.md`), and the edge-crypto lineage
> (`2026-06-30-edge-crypto-kernel-optimization-design.md`). Supersedes the open
> questions in issue #551.

## Product invariants (locked)

- **noy-db ships exactly one enclave**, and it is the USP: fully encrypted at
  store (AES-256-GCM, keys via PBKDF2→AES-KW, `crypto.subtle` only) **plus**
  encrypted-in-memory for developer-chosen sensitive fields (sealed slots /
  non-residency). This is a product invariant, not a configuration. The existing
  dev/test plaintext affordances (`encrypt: false`, `debugPlaintext`) live
  *inside* this one enclave and remain guarded by `stores-ciphertext-only`.
- **A sister project (nit-db) forks the repo and replaces `kernel/enclave/`
  wholesale** — its own at-store handling, its own in-memory policy (e.g. PDPA
  field classes), its own key story — and touches **nothing else**. noy-db is
  and stays *unaware* of any fork's data-protection regime: no profile engine,
  no PDPA/GDPR concept, no runtime enclave injection ever.
- **One component, not two.** At-store and in-memory protection share the key
  tree (sealed-field keys derive from DEK/CEK; `_cek` serves re-keying, tiers,
  and sealed delivery; `RecordCodec` decrypts bodies *and* unseals fields).
  Splitting them would put an interface through the CEK — the densest,
  most security-sensitive seam — for a swap neither noy-db nor any known fork
  performs. Rejected.

## Rejected alternatives (evaluated 2026-07-03)

- **Runtime injection** (`createNoydb({ enclave })`): breaks the lock (any
  dependency could swap crypto), cannot swap the key *type* (would force
  generics through 40+ spine files), and adds permanent runtime indirection for
  a swap noy-db users never perform.
- **Separate `@noy-db/enclave` package swapped via dependency overrides**:
  institutionalizes a supply-chain substitution point the lock forbids, and
  turns the 121-site migration into cross-package release coordination.
  May be revisited *after* the folder is self-contained, if fork-maintenance
  friction ever demands it — extraction is cheap then.
- **WASM component / Tink-style registries / TEE**: fail zero-crypto-deps,
  `crypto.subtle`-only, and hub portability ground rules.

Key insight: the expensive work (body-access consolidation) is **invariant
across all alternatives** — any swap mechanism requires services to stop
hardcoding the envelope body layout. Only the swap mechanism differs, and a
statically auditable source-level boundary beats a configurable one.

## Audit findings this design answers (2026-07-03 audit)

1. `EncryptedEnvelope` is spine-owned and **121 sites in ~55 files** outside the
   enclave read/write `_iv`/`_data`/`_cek`/`_det`/`_sealed` directly.
2. `CryptoKey` appears in **44 non-enclave files** (`getDEK` closures, CEK
   caches, keyring types).
3. The enclave folder has **inverted type-imports** (record-codec →
   `with-commit/crdt`; sealing → `with-party/team/managed-secret` +
   `with-audit/sealed-record`) and one service holds raw enclave crypto
   (`with-audit/sealed-record/index.ts` `subtle.importKey`).
4. Substantial **auth-layer crypto lives in with-party** (keyring derivation
   flow, a second PBKDF2 in `wrapped-deks.ts`, RSA-OAEP recipient sealing,
   session AES, transfer keys) plus five bare `subtle.digest` sites.
5. Only `RecordCodec` + `isTombstone` are on the unconditional core path;
   sealing / deterministic / per-record-keys are opt-in service territory.

## The contract

### C1 — Envelope: protocol header vs protected body

The envelope splits into two ownership zones:

- **Protocol header (family-owned, spine-defined, forks keep it):** `_noydb`,
  `_v`, `_ts`, `_by`, `_source`, `_sourceTs`, `_tier`, `_elevatedBy`. Stores,
  sync, history, and klum read these; they are wire protocol, not protection.
- **Protected body (enclave-owned):** `_iv`, `_data`, `_cek`, `_det`,
  `_sealed`, `_debug`. Only code inside `kernel/enclave/` may read or
  construct these fields. Everyone else goes through enclave helpers.

New barrel helpers (names final at plan time, semantics fixed here):

- `openEnvelopeJson(env, key): Promise<string>` — returns the body's JSON text
  (today: `decrypt(env._iv, env._data, key)`; plaintext path returns `_data`
  as-is). Replaces the dominant `decrypt(env._iv, env._data, …)` leak pattern.
- `writeEnvelopeBody(json, key, opts): Promise<BodyFields>` — produces the
  protected-body fields for callers that assemble envelopes (tiers, cargo,
  internal meta-writers).
- `hasPerRecordKey(env): boolean` — replaces raw `_cek !== undefined`
  discriminant checks.
- `envelopeBodyForHash(env): Uint8Array | string` — canonical body-bytes
  accessor for the ledger hash chain (replaces direct `_data`+`_sealed` reads
  in `with-commit/history/ledger/hash.ts`).

**Migration is a ratchet, not a big bang**: a new architecture check
`enclave-body-only` scans non-enclave `src/**` for protected-body field access,
grandfathered per-file at today's counts (the door-layering per-import pattern),
shrunk in review-gated batches. The check's grandfather list reaching zero is
the definition of C1 done; v1 ships the check + the helpers + the first
migration batches (highest-traffic sites first: the ~40 `decrypt(env._iv, …)`
sites and the `_cek` discriminants).

### C2 — `EnclaveKey`: the opaque key type

The barrel exports `type EnclaveKey` (in noy-db: `= CryptoKey`). A mechanical
sweep renames `CryptoKey` → `EnclaveKey` in every non-enclave signature that
traffics in record/DEK/CEK keys (the 44 files: `getDEK` closures,
`Lru<string, EnclaveKey>` caches, `SealingContext`/`DeterministicContext`/
`StableCekDeps`, keyring value types). A fork redefines the alias (e.g.
`type EnclaveKey = null`) and the spine type-checks against its keyless world
at fork-compile time. Auth-layer key types that never cross the enclave seam
(RSA recipient keys, session keys) are **not** renamed — they are with-party's.

### C3 — Self-contained folder

- Hoist the inverted type-imports so `kernel/enclave/**` imports only spine
  types (`kernel/types.js`, `kernel/errors.js`, `kernel/cache`, `kernel/schema`):
  the CRDT mode/state/strategy types referenced by `record-codec.ts` and the
  `RecipientSealer` / `SealedCekBinding` / `SealedCekDeliveryEnvelope` types
  referenced by `sealing.ts` move to `kernel/types.ts` (contract types — the
  services import them back from the spine, inward and legal).
- Move the raw `subtle.importKey` in `with-audit/sealed-record/index.ts` behind
  a barrel export (`importCek` or fold into an existing lifecycle helper).
- Acceptance: an architecture assertion that `kernel/enclave/**` has zero
  `with-*` imports (extend `enclave-barrel-only` or fold into `port-layering`).

### C4 — `EnclaveNotSupportedError`: the optional-groups failure mode

The barrel stays frozen (all 34+ symbols must exist in every fork), but the
**optional groups** — sealing, deterministic, per-record-key lifecycle — may
throw `EnclaveNotSupportedError` (new error class, spine `kernel/errors.ts`,
stable code `ENCLAVE_NOT_SUPPORTED`). The opt-in services (`sealed-record`,
`tiers`, deterministic queries) surface it verbatim. The unconditional core
(`RecordCodec`, `isTombstone`, base crypto ops) must never throw it. No
capability manifest, no runtime negotiation — noy-db stays unaware; fork
authors get a deliberate, documented "my enclave doesn't do X" lever.

### C5 — Conformance kit

`test-harnesses/enclave-conformance/` — the contract as an executable spec,
mirroring the existing `adapter-conformance` harness. A fork points it at its
enclave barrel and it verifies:

- envelope body round-trip (write → open → identical JSON; header untouched),
- tombstone semantics (`buildTombstone` → `isTombstone` true; live envelopes
  false; plaintext-mode behavior),
- key lifecycle coherence (wrap/unwrap identity where supported),
- optional-group behavior: each optional group either works end-to-end or
  throws `EnclaveNotSupportedError` consistently (never a mix per group),
- determinism where claimed (`encryptDeterministic` stability), and
- no protected-body field leaks in helper outputs.

noy-db's own enclave runs the kit in CI (proving the kit against the reference
implementation). Known-answer test vectors for the noy-db codec are included so
forks that claim wire-compat can verify it.

### C6 — Hygiene

The five bare `subtle.digest('SHA-256')` sites route through `sha256Hex`, and
`wrapped-deks.ts`'s second PBKDF2 routes through a barrel primitive (parameter
differences preserved — this is call-site consolidation, not a KDF change).
Auth-layer crypto otherwise **stays in with-party by design** (see scope).

## Out of scope (stated, deliberate)

- **Auth/unlock crypto** (keyring derivation flow, RSA-OAEP recipient sealing,
  magic-link HKDF, session AES, transfer keys): the enclave is the *data*
  enclave. A fork wanting different auth swaps the with-party service
  separately. Only the C6 hygiene touches these files.
- **Data-protection profiles (PDPA/GDPR engines):** fork-internal, inside the
  fork's enclave. noy-db never grows a compliance concept.
- **Residency/geo placement:** store-capability + routeStore + klum territory,
  its own future cycle (via `/cargo`).
- **Two-component split** and **enclave-as-package**: rejected above; the
  latter may be revisited once the folder is self-contained.
- **nit-db's actual fork migration:** nit-db is currently clean-room with zero
  enclave usage and its own inline envelope; adopting the fork model (family
  header + its own body handling) is nit-db's own project, enabled — not
  executed — by this contract.

## Success criteria

- `kernel/enclave/**` imports nothing from `with-*` (checked).
- `enclave-body-only` check exists, grandfathered, with the first migration
  batches landed and the grandfather count visibly reduced; helpers
  (`openEnvelopeJson` etc.) exported on the barrel and golden-frozen.
- `EnclaveKey` is the only record/DEK/CEK key type outside the enclave.
- `EnclaveNotSupportedError` defined; opt-in services surface it; core path
  provably never throws it (test).
- Conformance kit runs green against noy-db's enclave in CI.
- All existing goldens byte-identical except additive barrel/golden entries;
  full cross-package suite green.
- A fork guide (`docs/enclave-fork.md`): what to replace, what to keep, how to
  run the kit.

## Security review gates (this cycle is security-gated per #551)

- The body helpers must not widen access: `openEnvelopeJson` requires the same
  key material as today's direct calls; no helper returns key material.
- Sealed non-residency preserved: no helper materializes sealed fields into
  the plain working set; `forget()` RAM-scrub behavior unchanged.
- The adversarial review of the implementation must specifically attack:
  helper misuse enabling plaintext exfiltration, `EnclaveNotSupportedError`
  fail-open risks (a service treating "not supported" as "no protection
  needed" must fail closed), and hash-chain integrity across the
  `envelopeBodyForHash` migration.
