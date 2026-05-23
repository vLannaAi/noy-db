# Sealing + `at-*` dimension — foundation for #188–#198

> Internal foundation doc. Captures the dimensional model that grounds the
> open managed-mode / sealing / recovery / bundle-delivery work
> (#188 through #197). Not a public-facing document. Companion narrative
> ("the vault is the system, the bundle is one IO surface") is parked in
> §8 for the future README rebalance — do not surface yet.

## 0. Status

- Date: 2026-05-23
- Scope: pre-implementation foundation; precedes per-issue specs.
- Tracks: #188, #189, #190, #191, #192, #193, #194, #195, #196, #197, #198
- Builds on: `SealingKeyProvider` v1 (#186, pre.14), `at-env` reference (#187, pre.14), `on-shamir` primitives (shipped).
- Does **not** decide release sequencing — that's a separate brainstorm. This doc fixes the *model*.
- 2026-05-23 update: §12 (bundle transformation taxonomy) + §13 (partition × sealing/recovery soundness check) added after #198 landed mid-session; the §11 at-* architecture survives the composition test, modulo the `setupNewVaultIdentity` refactor in §13.2.

## 1. The vault-centric model

**The vault is the system.** It is the identity-bearing core. Everything else
is an IO surface over it.

The vault carries: the seal (KEK + sealing model), keyrings + per-user
envelopes, schema, guards, derivations, materialized views, overlay views,
declared deterministic predicates, data, history, audit ledger, policy gates.

The vault has **seven IO surfaces**, each answering one question about it:

| Family | Question | Examples |
|---|---|---|
| `to-*` | Where does the vault live at rest? | IDB, S3, R2, Postgres, Turso, SQLite, NFS, SMB, WebDAV, … |
| `by-*` | How do live sessions share one vault? | by-peer (WebRTC), by-tabs (BroadcastChannel) |
| `at-*` | Where does the sealing key live? | env, AWS/GCP/Azure KMS, macOS/Win/Linux keychain, WebAuthn-PRF |
| `on-*` | How does a user prove identity to unlock? | password, webauthn, oidc, pin, totp, email-otp, magic-link, shamir, recovery, threat |
| `as-*` | What format reads/writes the vault? | csv, json, sql, xlsx, ndjson, xml, zip, blob, **noydb** (full bundle) |
| `in-*` | What framework idiomatically embeds it? | React, Vue, Next, Nuxt, Pinia, Zustand, TanStack, Yjs, REST, AI |

Note on `as-noydb` / `.noydb` bundle: it is the only IO surface that
round-trips the *whole* vault in a single artifact (schema + logic + data +
history + auth structure). Every other `as-*` projects; every `to-*`
persists ciphertext slices; every `by-*` streams ciphertext deltas. That
property is why the bundle is special, but it is still derivative — the
vault is the noun, the bundle is one verb's output.

This model is descriptive, not prescriptive: the existing package-family
prefix convention (`to-/by-/at-/on-/as-/in-`) already lines up with it.
Naming the model gives future feature work a sharp test for *where it
belongs* — every proposed feature should land on exactly one IO surface
or be a property of the vault's core. Features that don't fit either are
suspect.

## 2. The sealing dimension, named

A `SealingKeyProvider` is the contract introduced in #186 / pre.14. Its
shape (paraphrased):

```ts
interface SealingKeyProvider {
  readonly id: string                            // stable, comparable
  seal(plaintext: Uint8Array): Promise<Uint8Array>
  unseal(sealed: Uint8Array): Promise<Uint8Array>
}
```

Used today by **managed-passphrase mode** (`passphraseMode: 'managed'`),
which:

1. Generates a fresh 256-bit random passphrase at vault creation.
2. Calls `provider.seal(passphrase)` and stores the result at
   `_meta/sealed-passphrase`.
3. At session open: reads `_meta/sealed-passphrase`, calls
   `provider.unseal(...)`, derives KEK via PBKDF2, opens the vault.

The user never sees the passphrase. The vault is unlockable iff a process
with access to the same provider can re-derive it.

### Boundary: `at-*` vs `on-*`

This is the load-bearing distinction and easy to get wrong (see memory
entry `project_auth_taxonomy.md` for prior confusion on IdP-bridge vs
authenticator). The corrected boundary:

| Aspect | `on-*` | `at-*` |
|---|---|---|
| What it answers | "How does a user *prove identity* to unlock?" | "Where does the *sealing key material* live?" |
| Authenticates a user? | Yes — it is a factor / proof. | No — it provides a key, no user proof. |
| Modes it serves | Standard passphrase mode (with optional tier-2 factors) | Managed mode (no user passphrase) |
| Example contract surface | `authenticate(challenge) → wrap-key material` | `seal(bytes) → sealed` / `unseal(sealed) → bytes` |
| User gesture | Typically yes (type password, tap key, click OIDC, …) | Typically no (env / KMS / keychain auto-resolves). Exception: WebAuthn-PRF requires a tap. |

The grey case: `at-webauthn-prf` (#194) uses a WebAuthn gesture to *derive*
the sealing key via the PRF extension. It is `at-*`, not `on-*`, because
the credential's output IS the sealing key — there is no separate
passphrase to unwrap. Compare to `on-webauthn`, which authenticates the
user and then unwraps a stored wrapped DEK; the credential is a proof, not
a key.

This rule disambiguates future provider proposals: ask **"does it carry
key material on its own, or does it carry proof that releases existing
key material?"** — the former is `at-*`, the latter is `on-*`.

### Threat-model honesty

The seal's strength is bounded by the chosen provider. Operationally:

| Provider class | Strength source | Documented weakness |
|---|---|---|
| `at-env` | OS-level env-var protection | Leaked `.env` → vault opens for anyone. Single-tenant boundary only. |
| `at-aws-kms` / `at-gcp-kms` / `at-azure-keyvault` | Hardware-backed KMS + IAM | IAM compromise → vault opens. Audit logs catch this post-hoc. |
| `at-macos-keychain` / `at-wincred` / `at-libsecret` | OS user-account isolation | Other processes as same user can read. Linux/libsecret with empty keyring password = weak. |
| `at-webauthn-prf` | Hardware authenticator + per-credential PRF | Credential loss = vault loss without recovery. Compromised browser at unlock-time. |

Every `at-*` README MUST document its threat model honestly. The
narrative "refuses to open on the wrong machine" is only as strong as
the chosen provider — overclaiming on the README would burn credibility
when a CVE-style story lands.

## 3. The `at-*` matrix

Four deployment surfaces, eight packages (one shipped, seven open):

| Surface | Package | Status | Issue | Notes |
|---|---|---|---|---|
| Server / container | `at-env` | shipped pre.14 | #187 | base64 32-byte AES key in env var |
| Server / cloud | `at-aws-kms` | open | #188 | KMS `Encrypt`/`Decrypt`; IAM-gated |
| Server / cloud | `at-gcp-kms` | open | #189 | Symmetric encrypt/decrypt; service-account-gated |
| Server / cloud | `at-azure-keyvault` | open | #190 | AES-KW (`wrapKey`/`unwrapKey`, RFC 3394) |
| Desktop | `at-macos-keychain` | open | #191 | via `@napi-rs/keyring` |
| Desktop | `at-wincred` | open | #192 | via `@napi-rs/keyring` (shared dep) |
| Desktop | `at-libsecret` | open | #193 | via `@napi-rs/keyring` (shared dep) |
| Browser | `at-webauthn-prf` | open | #194 | Web Crypto only; PRF extension; no native binding |

Cross-surface invariants every `at-*` package MUST honour:

- Implements the `SealingKeyProvider` interface from `@noy-db/hub`. No other surface.
- `id` is stable per (provider-class, identity-attributes). Round-trip
  `seal → unseal` MUST match across process restarts on the same machine
  with the same provider config. Tests gate this.
- Different identity-attributes (different KMS key ARN, different keychain
  service+account, different PRF salt) MUST produce mutually-unsealable
  outputs. Tests gate this.
- Native bindings are **peer-dependencies**, never hard dependencies, so
  the matrix doesn't force one platform's binding onto another's install.
- README documents the threat model honestly (see §2 table).
- Showcase included, env-gated where the surface requires real
  credentials (KMS, real keychain) — same `priority: low`, `showcases`
  label pattern as the existing `to-*` real-provider showcases.

The desktop triad (#191–#193) shares `@napi-rs/keyring` — that means the
marginal engineering cost beyond the first desktop provider is mostly
README + showcase + env-gated test per OS, not new native binding work.
This is a strong argument for shipping the triad together rather than
trickling them.

## 4. The recovery dimension

The sealing dimension and the recovery dimension are **orthogonal but
co-required** under managed mode. The vault must answer two independent
questions:

1. **Sealing**: where does the unlock material live in the normal case?
   (`at-*`)
2. **Recovery**: how does the vault survive losing the sealing material?
   (`on-recovery`, `on-shamir` today; multi-channel and admin-mediated
   to-be-defined — package vs. hub-built-in undecided, see §10)

#10 (pre.5) shipped `recoverPassphrase` end-to-end for the `paper` profile
only. The other three profiles (`shamir`, `multi-channel`,
`admin-mediated`) throw `RecoveryProfileNotImplementedError` today.

#196 is the actionable tracker for the descoped profiles. The framing
sharpens what "strong" means under managed mode:

| Profile | Strong under managed mode? | Reason |
|---|---|---|
| `paper` | **No** | Under managed mode the user has no passphrase to memorize. Losing the printout = losing every record permanently. Single-point-of-loss is structural. |
| `shamir` | **Yes** | k-of-n threshold; survives loss of up to n-k shares; no single party can mint a new sealed passphrase. |
| `multi-channel` | **Yes** | Recovery requires proof across N independent channels; single-channel compromise is insufficient. |
| `admin-mediated` | **Yes (conditional)** | Bound to admin authentication, not single-secret possession; audit-trail-heavy. Strong iff admin's own auth is strong. |

This table is the load-bearing input to #195's "managed mode rejects
creation without a strong recovery enrolled" rule. Paper alone under
managed mode is structurally banned at vault creation.

### Composability note

`on-shamir`'s defining feature, per its README, is that each share can
itself be protected by any other `on-*` method (share 1 behind WebAuthn,
share 2 behind OIDC, share 3 on paper in a safe). This composability is
already shipped at the primitives layer — #196 is purely hub-side
dispatch to wire it into `recoverPassphrase` and `rotateRecovery`.

## 5. Bundle handover at parity with live-vault session-open (#197)

A deep symmetry the dimensional model exposes:

- **Live-vault session-open** today: read `_meta/sealed-passphrase` from
  the store, call `provider.unseal(...)`, open vault.
- **Bundle handover import** today: bundle does not carry sealed
  unlock material. Recipient must obtain the passphrase out-of-band.

Both operations ask exactly the same question of a `SealingKeyProvider`:
*"Given this sealed payload and you, can you produce the unlock
material?"* Today only session-open answers yes.

#197 closes the asymmetry. After #197, a bundle can carry one of:

- **`autoPassphrases`** — plaintext `{ userId → passphrase }`. Public-by-design.
  Use case: demo data, sample datasets, public-access read-only sub-collections.
- **`sealedPassphrases`** — `{ userId → { sealedBy, sealingHint, sealed } }`.
  Recipient unseals with their matching `at-*` provider; if no provider matches,
  fall through to the manual-passphrase flow.

The implementation rides the **same `SealingKeyProvider` interface** —
there is no new mechanism, only a new application of the existing one.
That argues for #197 landing alongside the `at-*` family rather than
separately: the matrix and the bundle-delivery affordance are one story
operationally.

### Policy safety

`autoPassphrases` writes must be opt-in via an explicit build-time
policy flag, so a careless call doesn't silently leak credentials.
`readNoydbBundlePublicEnvelope` exposes **whether** an auto-unlock map
is present (and which kind) so cloud-listing UIs can warn before
download.

## 6. Issues remapped onto the dimensional model

| Issue | Dimension | What it adds to the vault |
|---|---|---|
| #188 `at-aws-kms` | seal | sealing-provider matrix gains cloud-KMS (AWS) |
| #189 `at-gcp-kms` | seal | sealing-provider matrix gains cloud-KMS (GCP) |
| #190 `at-azure-keyvault` | seal | sealing-provider matrix gains cloud-KMS (Azure) |
| #191 `at-macos-keychain` | seal | sealing-provider matrix gains desktop (macOS) |
| #192 `at-wincred` | seal | sealing-provider matrix gains desktop (Windows) |
| #193 `at-libsecret` | seal | sealing-provider matrix gains desktop (Linux) |
| #194 `at-webauthn-prf` | seal | sealing-provider matrix gains browser/hardware |
| #196 recovery dispatch | recovery | strong-recovery profiles become implementable |
| #195 managed-mode enforcement | recovery + policy | vault refuses creation in unrecoverable shapes |
| #197 bundle-delivery sealed envelope | as-noydb / IO | bundle handover gains parity with live session-open |
| #198 partition extraction with owner transfer | as-noydb / IO + identity | bundle becomes a re-keyed projection of the vault (new owner, transitive-closure subset); composes with #195/#196/#197 via the `setupNewVaultIdentity` refactor (§13.2) |

Reading this table top-to-bottom is the operational view of the
constellation: **seven seal-location additions, one recovery-survivability
addition, one policy-enforcement addition, one IO-surface parity
addition.** Not ten unrelated features.

## 7. Sequencing implications (model-level only)

The dimensional model has implications for ordering. Actual release
sequencing is a separate decision — these are constraints the model
places on it:

1. **#195 cannot ship without #196** — managed mode's "strong recovery
   required" gate has nothing to enforce until at least one strong
   profile dispatches. This is already encoded in #195's "blocks #196"
   relationship.

2. **#197 should ship alongside or after at least 2 `at-*` providers**
   (besides `at-env`). The bundle-delivery story reads as incomplete if
   the only sealing options are env + one other surface. Two
   non-env providers makes the matrix narrative honest.

3. **#196 Shamir slice has the lowest dispatch cost** of the three
   descoped profiles — primitives exist in `@noy-db/on-shamir`; the work
   is hub dispatch wiring + tests. Multi-channel needs new
   channel-coordination primitives. Admin-mediated needs the admin
   keyring authentication path. If we want #195 unblocked fastest,
   Shamir-first is the path.

4. **Desktop triad (#191–#193) is one engineering unit, not three** —
   shared `@napi-rs/keyring` peer-dep. Splitting across releases is
   inefficient.

5. **Cloud-KMS providers (#188–#190) are independent of each other** —
   each has its own SDK (`@aws-sdk/client-kms`, `@google-cloud/kms`,
   `@azure/keyvault-keys`). Could ship one, two, or all three. AWS is
   the most-recognized choice; GCP and Azure are matrix completions.

6. **`at-webauthn-prf` (#194) is the unique browser story** — no other
   `at-*` provider serves the browser surface. If the matrix narrative
   wants to claim 4-surface coverage (server / cloud / desktop /
   browser), #194 is non-optional.

## 8. Bundle narrative (parked)

> This section captures the bundle-as-protagonist framing surfaced
> 2026-05-23 for potential README rebalance later in the pre-release
> cycle. **Do not surface in current README; pre-release marketing
> still wants whole-feature-set framing.**

The framing: every package family is organized around the bundle's
lifecycle (create → seal → deliver → unseal → open → sync → derive →
query → backup). Every release's headline answer becomes "what does
the bundle now carry that it didn't before?" The README protagonist
becomes the `.noydb` file, not `createNoydb()`.

The framing's strength: it forbids things, not just permits them —
server-mediated features become second-class, features that don't
survive bundle round-trip become inconsistent with the narrative,
fuzzy sealing-provider claims become un-shippable. That's
operationally useful.

The framing's weakness for pre-release: it under-represents the
feature surface (storage breadth, integration depth, query
sophistication, derivation/MV system) that a stranger needs to see
on the README to evaluate whether to install. Pre-1.0, we likely want
breadth-first marketing; post-1.0 with the constellation landed, the
bundle-as-protagonist framing becomes the differentiation lead.

Revisit: when planning the README rewrite that accompanies whatever
release lands #197 + #195 + at least 3 `at-*` providers.

## 9. Open questions / risks

- **Q1.** Does `_meta/sealed-passphrase` need a versioned envelope format
  (algorithm id, key fingerprint, recovery-profile pointer) to support
  future provider rotation without rewrapping the entire vault? `at-env`
  shipped without it; cloud-KMS providers may want it to make key
  rotation cheap.
- **Q2.** When a bundle carries `sealedPassphrases` and the recipient
  has zero matching providers, the spec says "fall through to manual
  passphrase flow." Does that flow exist today for bundles? If not,
  designing that fall-through is part of #197.
- **Q3.** `at-webauthn-prf` and `on-webauthn` will coexist in browser
  apps. Are there installations where a single PRF-capable credential
  serves both roles (managed-mode seal + tier-2 factor)? The taxonomy
  says they're different — but the user-facing UX of "tap once" suggests
  consumers will conflate them. Document the boundary loudly.
- **Q4.** `admin-mediated` recovery (#196) requires the admin's own
  authentication to be strong. Is that recursively gated? E.g., admin
  in managed mode with `at-webauthn-prf` and no strong recovery of
  their own — can they still mediate? §4 says "strong iff admin's own
  auth is strong"; the dispatch needs to verify this at call time,
  not just at vault creation.
- **R1.** Supply-chain risk: 7 new packages, 3 with native peer-deps,
  3 with cloud-SDK peer-deps. The README breadth and per-package
  threat-model docs become load-bearing for adopter trust.
- **R2.** Cross-platform CI cost: real-keychain tests require
  per-OS runners (#191 darwin, #192 win32, #193 linux + libsecret +
  xvfb). Already partly in place for other tests; needs verification
  before committing to env-gated tests as part of #191–#193
  acceptance.

## 10. What this doc does not decide

- Release sequencing (which issues go in which `pre.X`).
- Implementation details per `at-*` package — those belong in per-issue
  specs (or per-PR design notes) written against this foundation.
- The README rewrite (parked; see §8).
- Whether `@noy-db/on-multi-channel` is a new package or lives inside
  `@noy-db/hub` as a built-in profile. Open for #196 spec.

## 11. Architecture deep-dive — sealing, seals, and bundle-carried seals

Drilling into the engineering primitives behind the dimension. This is
where the model meets the code; the §s below feed into per-issue specs.

### 11.1 The sealed-envelope format

Today's `_meta/sealed-passphrase` (#186) is **raw provider output** — a
`Uint8Array` whose interpretation is implicit in "the provider that wrote
it." That works for a single-provider vault. It breaks down the moment
the vault is asked to support **any** of:

- moving between providers (rotation),
- carrying seals from sender to recipient (#197),
- multi-provider sealing for defense-in-depth,
- algorithm migration within a provider.

The fix is a thin canonical wrapper. Proposed v1 shape:

```ts
type SealedEnvelope = {
  /** Envelope schema version. v1 = this shape. */
  v: 1
  /**
   * Provider class + identity attributes; matches `SealingKeyProvider.id`.
   * Examples: 'env:NOYDB_SEALING_KEY', 'aws-kms:arn:aws:kms:...',
   * 'macos-keychain:com.acme.app/alice@acme.example',
   * 'webauthn-prf:acme.example:abc123…' (truncated credentialId)
   */
  pid: string
  /** Sealing algorithm. Provider may expose multiple over time. */
  alg: 'aes-256-gcm' | 'aes-kw' | 'kms-encrypt' | 'rsa-oaep-sha256' | …
  /** Provider-specific reconstruction hints (KMS key spec, salt, etc). */
  hint?: Record<string, unknown>
  /** The actual sealed bytes — opaque to the wrapper. */
  payload: Uint8Array
}
```

Properties this gives us:

- **O(1) dispatch on import**: a recipient holding N providers can look at
  `env.pid` and pick the matching provider directly, no trial-and-error.
- **Rotation-friendly**: a vault rotating from `at-env` to `at-aws-kms`
  writes a new envelope; the old `pid` is auditable in ledger history.
- **Multi-provider**: `_meta/sealed-passphrase` can hold an *array* of
  envelopes (same plaintext sealed under N providers), and unseal picks
  the first whose `pid` it can serve. Defense-in-depth, no plaintext
  duplication.
- **Algorithm versioning**: `alg` lets a provider migrate its sealing
  algorithm without re-encrypting old payloads — old envelopes carry the
  old `alg`, the provider's unseal dispatches on the field.
- **Recipient-side honesty**: `hint` is in the clear, the payload is
  opaque. The recipient can decide whether to attempt unseal *before*
  surfacing a credential prompt.

This is a small additive change to #186's shape. `at-env` (shipped) can
be migrated transparently by wrapping its raw output once on first
re-write; the unseal path can sniff the magic-byte to handle legacy
raw-bytes envelopes for a release or two.

### 11.2 Provider capability matrix

Not all `at-*` providers can do all sealing operations. There are four
fundamental capabilities; every provider exposes a subset:

| Capability | What it means |
|---|---|
| **(A) seal** | Produce sealed bytes from plaintext, using local key material |
| **(B) unseal** | Recover plaintext from sealed bytes, using local key material |
| **(C) seal-for-recipient** | Produce sealed bytes using only the recipient's published hint, such that only the recipient can unseal |
| **(D) publish-recipient-hint** | Produce hint material a third party can use to seal-for-this-recipient |

(A) and (B) are required for round-trip; every provider has them. (C)
and (D) are the **handover capabilities** — they're what makes a
provider eligible to participate in #197's bundle-carried-seal flow with
arbitrary recipients.

Matrix across the eight `at-*` packages:

| Provider | A seal | B unseal | C seal-for-recipient | D publish-hint | Handover scenarios |
|---|---|---|---|---|---|
| `at-env` | ✓ | ✓ | ✗ | ✗ | **Self-targeted only**: sender holds the same env var. CI→CI provisioning. |
| `at-aws-kms` symmetric | ✓ | ✓ | ✓ (sender needs `kms:Encrypt` grant on recipient's key) | ✓ (KMS key ARN) | Cross-account handover with explicit IAM grant. |
| `at-aws-kms` asymmetric (RSA/ECC) | ✓ | ✓ | ✓ (sender uses recipient's public half — no grants) | ✓ (public key + alg) | **General-purpose handover**. The right shape for #197. |
| `at-gcp-kms` | ✓ | ✓ | depends on key type (symmetric / asymmetric, same as AWS) | depends | Same as AWS. |
| `at-azure-keyvault` | ✓ | ✓ | ✓ via RSA-OAEP key (asymmetric); AES-KW key needs explicit grant | ✓ (vault URL + key name) | General-purpose with RSA key. |
| `at-macos-keychain` | ✓ | ✓ | ✗ | ✗ | **Self-targeted only**: same machine, or iCloud-Keychain-synced devices, or MDM-provisioned same-org laptops. |
| `at-wincred` | ✓ | ✓ | ✗ | ✗ | Self-targeted: same Windows user, or same-org provisioning. |
| `at-libsecret` | ✓ | ✓ | ✗ | ✗ | Self-targeted: same Linux user, or shared D-Bus secret. |
| `at-webauthn-prf` | ✓ | ✓ | ✗ (PRF has no public half) | ✗ | Self-targeted only: same credential. Credential roaming via passkey sync (iCloud, 1Password, etc.) is the "same credential on multiple devices" case. |

The taxonomy that falls out:

- **Handover-capable** (have C+D, suitable for #197 with arbitrary recipients):
  `at-aws-kms` (asymmetric), `at-gcp-kms` (asymmetric), `at-azure-keyvault` (RSA).
- **Self-targeted** (only A+B; #197 works iff sender and recipient share key material):
  `at-env`, `at-macos-keychain`, `at-wincred`, `at-libsecret`, `at-webauthn-prf`.

This split is structural, not a quality difference. Local-only providers
have stronger threat models in their own right; they just can't seal
across the trust boundary without an out-of-band key share.

### 11.3 #197 use cases split by capability

#197's body lists `at-macos-keychain` as a `sealedBy` example. From the
matrix, that only works in one of:

- **Self-backup**: I export my own vault, sealed under my own keychain
  entry. Restored later on a new machine that shares the same keychain
  entry via iCloud Keychain sync.
- **Same-org provisioning**: build machine and user laptops share the
  keychain entry via MDM. The bundle is built once and provisioned to
  fleet devices.

For **arbitrary recipient delivery** (the canonical "SaaS hands a
customer their bundle" case in #197's motivation), the recipient must
either:

1. publish a handover hint from a handover-capable provider (cloud-KMS
   asymmetric or AES-KW with grant), and the sender seals against that
   hint;
2. OR share key material out-of-band ahead of time (degenerate trust
   boundary; only sensible inside same-tenant infrastructure).

This means **#197 has two operating modes that should be named in its
spec**:

| Mode | Sender's relationship to recipient | Suitable providers |
|---|---|---|
| `mode: 'self-target'` | Sender = recipient, or shared trust boundary (same iCloud Keychain, same MDM fleet, same KMS account) | Any `at-*` |
| `mode: 'recipient-target'` | Arbitrary recipient who has published a handover hint | Handover-capable only (cloud-KMS asymmetric / RSA Key Vault / AWS-KMS-with-grant) |

Both modes use the same `SealedEnvelope` format; they differ in **how
the sender produces it**. Self-target uses the sender's own provider's
`seal(plaintext)`. Recipient-target uses a new operation —
`sealForRecipient(plaintext, recipientHint)` — that asymmetric/granted
providers expose.

This split is invisible to the bundle reader (the recipient just calls
`unseal` against the envelope using their local provider; the envelope's
`pid` says which one to try). It's the *bundle author's* mental model
that changes: they pick the mode at build time based on who's getting
the bundle.

### 11.4 Resolution of Q11.A — split interfaces (RecipientSealer)

Decision: handover capability lives as a **separate `RecipientSealer`
interface** that handover-capable providers additionally implement.
Self-targeted providers stay on the simpler `SealingKeyProvider`.

```ts
// Every at-* package implements this. The minimum contract.
interface SealingKeyProvider {
  readonly id: string
  seal(plaintext: Uint8Array): Promise<SealedEnvelope>
  unseal(env: SealedEnvelope): Promise<Uint8Array>
}

// Handover-capable providers ALSO implement this.
// at-aws-kms (asymmetric/grant), at-gcp-kms, at-azure-keyvault (RSA) do.
// at-env, at-macos-keychain, at-wincred, at-libsecret, at-webauthn-prf do NOT.
interface RecipientSealer {
  readonly id: string
  /** Produce hint material a sender uses to seal-for-this-recipient. */
  publishRecipientHint(): Promise<RecipientHint>
  /** Seal plaintext for the recipient described by `hint`. */
  sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<SealedEnvelope>
}

type RecipientHint = {
  v: 1
  /** Recipient's provider id; matches the SealedEnvelope.pid they'll unseal under. */
  pid: string
  /** Algorithm the sender uses to produce the seal. */
  alg: 'rsa-oaep-sha256' | 'kms-encrypt-cross-account' | …
  /** Public material — RSA public key (PEM), KMS ARN, etc. */
  material: Record<string, unknown>
}
```

Rationale:

- **Type-system honesty.** The §11.2 capability matrix IS the type
  system in code. A function that requires recipient-target sealing
  takes `RecipientSealer`, not `SealingKeyProvider` — the compiler
  rejects passing a keychain provider at the spec site, not at runtime
  in some user's living-room laptop.
- **Self-targeted providers stay simple.** No noisy `throw "not
  supported"` stubs on every package; the matrix is encoded in which
  interfaces each package implements.
- **Future capabilities compose.** A later `EnvelopeVerifier` (verify
  signature without unsealing), `EnvelopeRotator` (cross-provider
  re-seal without exposing plaintext to userland), or
  `MultiRecipientSealer` (seal once for N recipients) each land as
  their own optional interface, declared by the providers that can do
  them.
- **README language clarifies.** "RecipientSealer providers" /
  "handover-capable `at-*` providers" become first-class terms.

API consequence for #197 (two-mode bundle API):

```ts
// Mode 1 — self-target. Sender's provider also is (or shares) the recipient's.
await writeNoydbBundle(vault, {
  sealedPassphrases: {
    mode: 'self-target',
    provider: macosKeychainSealingProvider({ … }),  // SealingKeyProvider
    perUser: { 'alice': 'alice-pass', 'bob': 'bob-pass' },
  },
})

// Mode 2 — recipient-target. Recipients have published handover hints.
await writeNoydbBundle(vault, {
  sealedPassphrases: {
    mode: 'recipient-target',
    provider: awsKmsSealingProvider({ … }),  // RecipientSealer
    perUser: {
      'alice': { passphrase: 'alice-pass', hint: aliceRecipientHint },
      'bob':   { passphrase: 'bob-pass',   hint: bobRecipientHint },
    },
  },
})
```

The reader API is symmetric across modes — both yield a `SealedEnvelope`
on the wire, both are unsealed by the recipient's local provider via the
standard `unseal(env)` call. The mode is invisible past the bundle
boundary.

### 11.5 The two sealing scopes

Sealing happens at two different scopes today, and the constellation
adds a third. Naming them prevents conflation in future design:

| Scope | What's sealed | Storage location | Used by |
|---|---|---|---|
| **Vault-level** | The vault's master unlock secret (managed mode's auto-generated 256-bit random) | `_meta/sealed-passphrase` inside the vault store | Managed mode session-open (#186) |
| **Keyring-level (per-user)** | A specific user's login passphrase | Inside the `.noydb` bundle artifact, per-userId | Bundle delivery (#197) |
| **KEK-level** (implicit today) | The KEK itself wrapped under a KMS key | KMS-internal (never surfaces) | Cloud-KMS providers can do this natively via AES-KW; today we don't expose it as a scope, we wrap a passphrase instead. Noted for future. |

Key observations:

- **Vault-level scope is implemented today** (#186). One seal per vault.
  Lives in the store. Updated on rotation.
- **Keyring-level scope is what #197 adds.** N seals per bundle, one
  per recipient userId. Lives in the bundle. Frozen at export time.
- These scopes **don't conflict** — a managed-mode vault could
  conceivably export a bundle that ALSO carries keyring-level seals
  for each user, but for managed mode the "user passphrase" is the
  auto-generated random shared by all users → per-user variation
  collapses to one envelope. **#197 is most coherent for standard-mode
  vaults**, where each user has their own login passphrase.
- The KEK-level scope is interesting future ground. Today managed mode
  seals a *passphrase* and re-derives the KEK via PBKDF2 on every
  open. A future "KMS-wrap mode" could seal the KEK directly via AES-KW,
  saving the PBKDF2 round trip. Not in scope here.

### 11.6 The bundle-carried seal lifecycle

A bundle-carried seal is **frozen at export time**. The live vault may
rotate its sealing provider after the bundle is written; the bundle
still works because it carries its own copy of the sealed plaintext.
This creates a *fork in the seal timeline*:

```
                                              [vault rotates seal at T+1]
                                                       │
                                                       ▼
vault at T:  sealed under provider X  ──────►  sealed under provider Y
                  │
                  │ (exported as bundle at T)
                  ▼
bundle:  carries SealedEnvelope{ pid: X, payload: ... }
                  │
                  │ (delivered to recipient at T+N)
                  ▼
recipient:  has provider X locally  →  unseals OK at T+N regardless of
                                       vault's current provider state.
```

This is structurally correct — the bundle is a snapshot, not a live
connection. But it raises the **import-time policy question**: when the
recipient successfully unseals the bundled envelope, what happens next?

Three options:

1. **Adopt the bundled seal verbatim.** The recipient's local
   `_meta/sealed-passphrase` becomes a copy of the bundled
   `SealedEnvelope`. The recipient now operates under the same provider
   identity the sender used. **Implication**: trust boundary stays with
   the sender's provider; recipient must keep that provider's key
   material available.
2. **Re-seal locally under recipient's own provider** (Recommended).
   On import, unseal once with the bundled envelope, then immediately
   re-seal under the recipient's local provider, persist to
   recipient's `_meta/sealed-passphrase`, drop the bundled envelope.
   **Implication**: trust boundary moves to recipient. Recipient owns
   their own provider lifecycle from import forward.
3. **Both, configurable.** Default to (2), allow (1) via explicit
   `keepSenderSeal: true` for "fleet provisioning" cases where the
   recipient genuinely wants to operate under the sender's sealing
   identity.

Recommendation: implement (2) as default with (3) opt-in. Reasons:

- Aligns with the dimensional principle that **the vault is identity**;
  the recipient's vault should have a sealing identity owned by the
  recipient.
- Reduces the "I imported a customer bundle and now my customer's
  AWS-KMS access is on my critical path" footgun.
- The fleet-provisioning use case (where (1) is right) is real but
  niche; making it explicit prevents accidental adoption.

This import-time re-seal is **not free** — it requires the recipient to
have a configured `at-*` provider at import time. The flow needs a
clear error path for "no local provider configured; either configure
one or pass `keepSenderSeal: true`."

### 11.7 Provider rotation paths

Three rotation operations the constellation enables (none of them
implemented today):

**Op A — Same-provider, new-key rotation.** E.g., `at-aws-kms` user
rotates the KMS key alias to point at a new key version. KMS handles
this internally if the envelope's `pid` encodes the *alias*, not a
specific version. Implementation: provider's `unseal` MUST handle
either current or recently-rotated key versions transparently. KMS
does this via `kms:Decrypt` automatically; document the requirement.

**Op B — Cross-provider rotation** (`rotateSealingProvider`).
The 80% case. Unseal under provider X, re-seal under provider Y, swap
`_meta/sealed-passphrase`. Atomic semantics: write new envelope at
`_meta/sealed-passphrase.pending`, verify by re-opening the vault under
new provider, swap-atomically, then delete `.pending`. Ledger entry
records the `(X.id, Y.id, timestamp)` tuple. New policy gate
`rotate-sealing-provider` (parallels existing `rotate-passphrase`).

**Op C — Multi-provider sealing** (defense-in-depth, deferrable).
`_meta/sealed-passphrase` becomes `_meta/sealed-passphrases` (array of
`SealedEnvelope`). Unseal tries each in pid-order until one matches a
local provider. Useful when (e.g.) `at-aws-kms` is primary but
`at-macos-keychain` is the disaster-fallback. Bumps envelope schema
to v2; deferring this past first release seems wise — the v1 envelope
shape doesn't preclude it (just wrap singleton in an array later).

Sequencing: Op B is the load-bearing one for the constellation —
without it, a vault committed to `at-env` early can never move to
`at-aws-kms` without a full re-create. Ship Op B alongside the first
non-`at-env` provider (so the day someone installs `at-aws-kms`, they
can also migrate to it from `at-env`).

### 11.8 Open architectural questions — status after Round 1

| Question | Status | Where |
|---|---|---|
| **Q11.A** — single `SealingKeyProvider` vs split `RecipientSealer`? | **Resolved**: split | §11.4 |
| **Q11.B** — `pid` stability guarantee across provider library versions? | Open | — |
| **Q11.C** — Multi-provider sealing (array of envelopes)? | Partly resolved: defer past first release, v1 envelope shape doesn't preclude it | §11.7 Op C |
| **Q11.D** — Trial-and-error unseal vs strict `pid` dispatch? | Open | — |

Carrying into Round 2:

- **Q11.B (pid stability).** Once a `pid` format ships, every existing
  envelope in the wild is anchored to it. The closest analogue in the
  ecosystem is the `to-*` adapter `{ resource, kind, id }` triple — also
  treated as a public stability boundary. Lean toward declaring `pid`
  format frozen post-first-release, with a `pid v1 → v2` migration story
  documented if we ever need to evolve it. Decide before #188 (first
  non-env provider) ships.
- **Q11.D (trial-and-error).** Strict `pid` dispatch is the safer
  default — it catches "wrong provider configured" early. Trial-and-error
  has a real use case when moving across deployment surfaces (a vault
  migrating from cloud to on-prem) but should be opt-in via an explicit
  `attemptUnsealAcrossProviders: true` flag, not silent fallback.
  Probably resolve at the same time as Op B (cross-provider rotation),
  since both touch the "multiple providers present at the same time"
  shape.

New Round-2 questions arising from §11.4–11.7:

- **Q11.E** — Recipient hints are published once and persisted by the
  sender. How are they refreshed when the recipient rotates their
  underlying KMS key? Argues for a `hintVersion` and a "republish to
  the sender" channel. Not in scope for v1; document the limitation.
- **Q11.F** — On import, the §11.6 default (re-seal locally) requires
  the recipient to have an `at-*` provider configured. If they don't,
  fail-closed message must be actionable: "No `at-*` provider
  configured. Either configure one for vault `xyz` or import with
  `keepSenderSeal: true` (advanced — keeps the sender's sealing
  identity on your local vault)." UX detail; document.
- **Q11.G** — Cross-provider rotation (§11.7 Op B) under managed mode
  with #195's mandatory strong-recovery interacts subtly: rotating the
  sealing provider doesn't invalidate the existing recovery proofs (they
  unwrap the same DEKs), but the policy gate `rotate-sealing-provider`
  might want to require a recovery proof as part of the rotation
  ceremony for symmetric defense. Open for #195's spec.

## 12. Bundle transformation taxonomy

A bundle is not "an export of the vault." It is a **transformed
projection of the vault**, and the transformations are orthogonal along
three axes. Naming this taxonomy clarifies what existing primitives do,
what's new in #197 and #198, and what compositions are sensible.

### 12.1 The three orthogonal axes

| Axis | Variants | Question it answers |
|---|---|---|
| **Filter** | `full` / `slice` / `partition-closure` | What subset of the source's data travels? |
| **Keyring** | `same` / `rotated` / `multi-recipient` / `re-keyed-new-owner` | Who can open the resulting bundle and in what role? |
| **Unlock** | `out-of-band` / `unsealed-carried` / `sealed-carried` | How does the recipient obtain the passphrase to log in? |

Detail per axis:

**Filter axis**
- `full` — every record, every collection. Source = destination dataset.
- `slice` — `where: predicate` and/or `collections: [allowlist]` and/or
  `since: ledgerCutoff`. Today's `writeNoydbBundle` options.
- `partition-closure` — `seeds: { collection: predicate }` plus
  `followReferences: FkDescriptor[]` to compute transitive closure.
  New in #198.

**Keyring axis**
- `same` — bundle carries the source's keyring verbatim. Today's default.
- `rotated` — new KEK / new DEKs, same set of users. Today's
  `recipients[]` shorthand with a single recipient.
- `multi-recipient` — new KEK / new DEKs, an explicit per-slot ACL.
  Already shipped (multi-recipient re-keyed bundles).
- `re-keyed-new-owner` — fresh KEK / fresh DEKs, fresh keyring built
  around a NEW owner (carried-over users opt-in only). New in #198.

**Unlock axis**
- `out-of-band` — bundle ships passphrase-free; recipient acquires
  the unlock material separately. Today's default.
- `unsealed-carried` — bundle ships `autoPassphrases: { userId →
  plaintext }`. Public-by-design (demos, sample data). New in #197.
- `sealed-carried` — bundle ships `sealedPassphrases: { userId →
  SealedEnvelope }` per §11.4's two-mode API. New in #197.

### 12.2 Existing primitives mapped onto the axes

| Primitive | Filter | Keyring | Unlock |
|---|---|---|---|
| `writeNoydbBundle(vault)` | `full` | `same` | `out-of-band` |
| `writeNoydbBundle(vault, { where, collections, since })` | `slice` | `same` | `out-of-band` |
| `writeNoydbBundle(vault, { recipients: [...] })` | `full`/`slice` | `multi-recipient` | `out-of-band` |
| **#197 auto-passphrase** | any | any | `unsealed-carried` |
| **#197 sealed-passphrase** | any | any | `sealed-carried` |
| **#198 extractPartition** | `partition-closure` | `re-keyed-new-owner` | any (composes with #197) |

The taxonomy makes #198 visible as **a specific composition** —
`partition-closure × re-keyed-new-owner × any-unlock` — rather than a
brand-new mode. It also makes the headline use case (consumer-app spins
off a sub-portfolio to a new department) decomposable: `partition-closure
× re-keyed-new-owner × sealed-carried` is the full "extract the hotel
clients, give the new owner her own vault, auto-unlock on her laptop"
flow. Three axes, each chosen independently.

### 12.3 Compositionality matrix

Not all 3×4×3 = 36 combinations are coherent. The constrained ones:

- `multi-recipient` keyring with `sealed-carried` unlock requires
  **per-recipient sealed envelopes** — one envelope per recipient, each
  under the recipient's own `at-*` provider hint. Already implied by
  §11.4's `perUser` shape.
- `re-keyed-new-owner` keyring with `unsealed-carried` is **dangerous
  by default** — a partition's auto-passphrase is the full unlock for
  the new owner; leaking it grants ownership of a standalone vault.
  Should require the same explicit opt-in flag as #197's `autoPassphrases`
  policy gate, doubled-gated for partition extraction.
- `partition-closure` filter requires `re-keyed-new-owner` keyring **or**
  `same` keyring. The middle options (`rotated`, `multi-recipient`)
  don't have an obvious use case under partition extraction.
  Document the constraint; reject other compositions at the API site.

### 12.4 The bundle public header is becoming a stability surface

Two adjacent header fields are appearing:

- `bundleKind: 'snapshot' | 'extracted-partition'` from #198
- `autoUnlock: 'unsealed' | 'sealed' | null` (implied) from #197

These are read **pre-decryption** by cloud listers, import previews, and
human operators deciding whether to download. Treat as a structured
`BundlePublicHeader` schema with its own stability guarantee, semver-frozen
for the same reason `SealedEnvelope.pid` is. Add fields liberally
(everything's optional → backwards-compatible); never remove or rename.

Sketch:

```ts
type BundlePublicHeader = {
  v: 1
  kind: 'snapshot' | 'extracted-partition'
  /** Source vault identifier, for forensics — never required for opening. */
  sourceVaultId?: string
  /** Indicates if the bundle ships its own unlock material. */
  autoUnlock?: 'unsealed' | 'sealed'
  /** Public-envelope metadata override (display name, etc.) */
  publicEnvelope?: { name?: string; description?: string }
  /** Created-at timestamp, opaque-clock-domain. */
  createdAt?: string
}
```

## 13. Partition extraction × sealing/recovery — soundness check

This section sketches how #198 composes with the §11 architecture and
identifies what (if anything) needs to change in the at-* foundation
to make the composition clean.

### 13.1 The composition target

`extractPartition` needs to perform, in order:

1. **Graph traversal** — walk source records from seed predicates
   through `followReferences` to a closure set.
2. **Identity setup** — create the destination vault's keyring with a
   new owner + optional carried-over users.
3. **Crypto setup** — mint fresh KEK, fresh per-collection DEKs.
4. **Sealing setup** — if `passphraseMode: 'managed'`, seal the
   destination's auto-passphrase under the chosen `at-*` provider
   (§11.4).
5. **Recovery enrollment** — enroll at least one strong recovery
   profile per #195's policy gate (§4 table); the new vault's
   recovery is independent of source.
6. **Bundle materialization** — re-wrap selected envelopes' `_data`
   under new DEKs, write the keyring, write `_meta/sealed-passphrase`
   if managed, write `bundleKind: 'extracted-partition'` header.
7. **Optional carried seal** — per #197 two-mode API, the destination
   owner's passphrase can be sealed inside the bundle for delivery.
8. **Optional source-side delete** — `source.onExtracted:
   'delete-extracted'` deletes the closure set from source atomically
   with respect to the bundle's durability.

Steps 2–5 are *exactly* what `createNoydb` does today, modulo the
"create the empty store" step. Steps 2–5 + 7 are exactly what a
hypothetical "create + carry-seal" path would do.

### 13.2 Proposed factoring — `setupNewVaultIdentity`

Refactor `createNoydb`'s identity-creation phase into a reusable
internal:

```ts
// Internal — not exported. Used by createNoydb and extractPartition.
async function setupNewVaultIdentity(opts: {
  owner: { userId: string }
  passphraseMode?: 'standard' | 'managed'  // default 'standard'
  passphrase?: string                       // standard: required; managed: omitted (auto-minted)
  sealingKey?: SealingKeyProvider           // managed: required
  recovery: RecoveryProfileEnrollment[]     // #196 dispatch; #195 enforces strong-if-managed
  policy?: PolicyPreset                     // PERSONAL / TEAM / STRICT
  publicEnvelope?: PublicEnvelopeInit
}): Promise<{
  keyring: Keyring                          // ready to write
  kek: CryptoKey                            // in-memory only
  deks: Map<CollectionName, CryptoKey>      // in-memory only
  sealedPassphraseEnvelope?: SealedEnvelope // present iff managed
  recoveryEnvelopes: RecoveryEnvelope[]     // ready to write
  publicEnvelope: PublicEnvelope            // ready to write
  // For #197 use:
  carriedSealedPassphrase?: SealedEnvelope  // present iff sealedPassphrases requested
}>
```

Both `createNoydb` and `extractPartition` then become thin orchestrators:

```ts
// createNoydb
const identity = await setupNewVaultIdentity({ owner, passphraseMode, sealingKey, recovery, ... })
await initializeStore(store, identity)

// extractPartition
const closure = await walkClosure(sourceVault, { seeds, followReferences })
const identity = await setupNewVaultIdentity({
  owner: reKey.newOwner,
  passphraseMode: reKey.passphraseMode,
  sealingKey: reKey.sealingKey,
  recovery: reKey.recovery,
  ...
})
const bundleBytes = await materializeBundle({
  identity,
  records: closure,
  reWrapDataUnder: identity.deks,
  header: { kind: 'extracted-partition', ... },
  carriedSealedPassphrase: identity.carriedSealedPassphrase,
})
if (source.onExtracted === 'delete-extracted') {
  await deleteFromSourceAtomicallyWith(sourceVault, closure, bundleBytes)
}
```

### 13.3 Soundness verdict

The composition is **clean**, modulo one small refactor:

- ✅ Sealing-provider matrix (`at-*`): unchanged. `extractPartition`
  uses the same `SealingKeyProvider` interface.
- ✅ Recovery dispatch (#196): unchanged. `extractPartition` accepts
  the same `RecoveryProfileEnrollment[]` shape as `createNoydb`.
- ✅ #195's mandatory-strong-recovery rule: applies symmetrically.
  An extracted partition in managed mode rejects extraction if no
  strong recovery is enrolled, same gate as createNoydb.
- ✅ #197's two-mode API: composes via the `carriedSealedPassphrase`
  output of `setupNewVaultIdentity`. The bundle materialization step
  writes the carried envelope alongside the sealed-passphrase, gated
  by the §12.3 compositionality rules.
- ⚠️ Refactor needed: `setupNewVaultIdentity` doesn't exist today.
  Today's identity-creation logic is interleaved with store
  initialization inside `createNoydb`. The factoring is mechanical
  but touches the load-bearing vault-creation code path — should
  land BEFORE #198's spec depends on it. Reasonable PR boundary:
  the refactor lands as a no-functional-change preparatory PR, then
  #198's per-issue spec can assume the internal exists.

The refactor verdict is the load-bearing finding: **#198 doesn't need
new sealing/recovery architecture — it needs the existing architecture
exposed as a reusable internal.** This is the most encouraging
soundness check result we could get; it confirms the §11 design holds
under stress.

### 13.4 New infrastructure #198 needs that the foundation doesn't cover

Listing what #198 needs that §11 doesn't address — these are
out-of-scope for this foundation doc but should be tracked:

- **Cross-vault atomic transaction** for `source.onExtracted:
  'delete-extracted'`. Today's `runTransaction` is single-vault. Either
  (a) two-phase commit pattern, (b) accept non-atomicity with a
  recovery story ("if the source delete fails partway, the source has
  inconsistent state; here's how to rollback from the freshly-produced
  bundle"), or (c) the delete becomes a post-extraction step the
  caller runs after confirming bundle durability. Open design.
- **Transitive-closure walker primitive.** Operates on plaintext, so
  it must run inside the unlocked-vault session. The
  `followReferences` descriptor shape parallels `withGuard`'s
  cross-collection FK invariants — should compose with declared FKs
  rather than requiring redundant declaration. Open design.
- **Cycle detection in the walker.** `followReferences` may form
  cycles (`A.fkB → B.fkC → C.fkA`). The walker must converge.
  Standard fixed-point iteration with seen-set.
- **Performance bound for the walker.** Worst case is O(records) per
  collection in the closure × graph diameter. For consumer-firm-scale
  vaults (10k–100k records, ≤20 collections, FK graph depth ≤5), this
  is tractable; for very large vaults it could be a multi-minute
  operation. Document the bound; consider opt-in pagination later.

These belong in #198's own spec, not in the at-* foundation. Cross-ref
from #198's spec back to §13 here for the sealing/recovery composition.

---

Cross-references:

- Memory: `project_auth_taxonomy.md`, `project_package_naming.md`,
  `feedback_pre15_union_mv_design_pins.md`
- ROADMAP.md "In flight" + "Recently shipped"
- Issues: #186 (closed), #187 (closed), #188–#197 (open), #10 (closed)
- Primitives: `@noy-db/on-shamir` README; `packages/hub/src/sealing-key/`
