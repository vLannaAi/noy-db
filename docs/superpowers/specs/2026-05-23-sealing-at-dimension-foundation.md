# Sealing + `at-*` dimension — foundation for #188–#197

> Internal foundation doc. Captures the dimensional model that grounds the
> open managed-mode / sealing / recovery / bundle-delivery work
> (#188 through #197). Not a public-facing document. Companion narrative
> ("the vault is the system, the bundle is one IO surface") is parked in
> §8 for the future README rebalance — do not surface yet.

## 0. Status

- Date: 2026-05-23
- Scope: pre-implementation foundation; precedes per-issue specs.
- Tracks: #188, #189, #190, #191, #192, #193, #194, #195, #196, #197
- Builds on: `SealingKeyProvider` v1 (#186, pre.14), `at-env` reference (#187, pre.14), `on-shamir` primitives (shipped).
- Does **not** decide release sequencing — that's a separate brainstorm. This doc fixes the *model*.

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

---

Cross-references:
- Memory: `project_auth_taxonomy.md`, `project_package_naming.md`,
  `feedback_pre15_union_mv_design_pins.md`
- ROADMAP.md "In flight" + "Recently shipped"
- Issues: #186 (closed), #187 (closed), #188–#197 (open), #10 (closed)
- Primitives: `@noy-db/on-shamir` README; `packages/hub/src/sealing-key/`
