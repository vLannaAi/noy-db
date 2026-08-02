# echo-secret — 3-part anti-phishing tier-1 ceremony

- **Status:** draft, awaiting maintainer approval
- **Tracking:** issue [#940](https://github.com/vLannaAi/noy-db/issues/940), milestone #45 `echo-secret: anti-phishing tier-1 ceremony [api]`
- **Date:** 2026-08-02

## Overview

A third tier-1 secret mode, `secretMode: 'echo'`, alongside `'standard'` and `'managed'`.
The secret is one memorable sentence enrolled as three structured parts:

```
prompt (typed) → echo (revealed by the vault) → key (typed)
e.g.  "mi chiamo vicio" → "ma da piccolo al sant.anna mi chiamavano" → "ciccio"
```

At unlock the owner types the **prompt**. The vault proves it actually holds the
secret by revealing the **echo** — the middle of the owner's own sentence, which no
phishing page can produce. The owner recognizes it and completes with the **key**.
Wrong or absent echo ⇒ hard phishing warning: do not continue, open the official
app, rotate the secret.

The ceremony is a property of the **data**, not the app: it is declared in the
`KeyringFile` format, and a pod recipient slot IS a `KeyringFile`
(`writePod({ recipients })`), so a data-only orphaned pod opened by any conforming
player still gets the 3-part handling.

## Goals

- G1. Harden the tier-1 phrase ceremony — the surface passkeys leave exposed —
  against phishing, without touching daily tier-2/tier-3 fast unlock.
- G2. The ceremony travels with every pod; generic/universal players enforce it
  because the format and the API leave them no single-field alternative.
- G3. Graceful degradation: a slot without a reveal-blob still runs a verified
  stepwise ceremony (no mutual-auth reveal, structure retained).
- G4. Double as a memory aid: the revealed echo is a retrieval cue for the key —
  fighting the dominant real-world tier-1 failure (forgetting a rare secret).

## Anti-goals

- **AG-1 (core invariant): no single typed string may derive an echo vault's KEK.**
  KDF input is a length-prefixed encoding of the three parts
  (`len(prompt)‖prompt‖len(echo)‖echo‖len(key)‖key`), so no concatenation with any
  separator is key-equivalent. Separators like `#` are display sugar in player
  enrollment UIs only; they never appear in the crypto layer or on disk. This
  forecloses "extreme recovery via direct full-secret input" — which would be an
  officially-shipped phishing flow.
- AG-2. No protection claim against a malicious player the owner feeds the pod to —
  nothing survives typing a secret into hostile code. The target is honest/lazy
  players and remote phishing pages.
- AG-3. No new satellite package and no `with-*` service for v1 — kernel format +
  kernel ceremony only.

## Threat model (attacker grades)

| Grade | Holds | Outcome |
|---|---|---|
| A — static clone | nothing | **Defeated.** Cannot produce the echo. |
| B — the ciphertext/pod file | keyring incl. any portable reveal-blob | Defeated **only** by `reveal: 'sealed'` (device-sealed blob). Portable slots are grade-A protection by explicit choice. |
| C — flow substitution ("enter your full secret") | nothing | **Defeated structurally** by AG-1: no working single-string form exists, so no legitimate single-field flow exists to imitate. |
| Malicious player | the pod + the UI | Out of scope (AG-2). |

Human factors: daily unlock stays tier-2/tier-3, so the echo ceremony fires only on
rare, high-attention events — no habituation (the failure that killed
SiteKey-style security images; Schechter et al. 2007). Residual risks stay
documented: shoulder-surf of the displayed echo (masking), autobiographical
content (enrollment guidance: private memory or deliberately false fact, never
OSINT-able biography — the example sentence above is deliberately what NOT to do).

## Design decisions (locked 2026-08-02)

1. **Kernel placement.** `KeyringFile` format extension + enclave-area ceremony
   module. Rejected: tier-2 `authenticators[]` slot (leaves a plain phrase as the
   real root); opt-in `with-*` service or `on-*` package (ceremony must not be
   optional once the data declares it).
2. **Flat mode enum**: `secretMode?: 'standard' | 'echo' | 'managed'`
   (kernel `types.ts`, currently `'standard' | 'managed'`). No nested
   `phraseFormat`; no invalid combinations to police. Echo is orthogonal to
   managed (which has no typed secret and is unphishable by construction).
3. **KEK derives from all three parts** via the AG-1 length-prefixed encoding,
   PBKDF2-SHA256 600K (`crypto.subtle` only), same iteration floor as standard.
4. **Hybrid reveal policy, per slot** (see Format). Live/device keyrings:
   `sealed` when a `DeviceSealProvider` is supplied at `createNoydb`, else
   `portable`. Pod recipient slots: `portable` by default, per-recipient knob.
5. **`DeviceSealProvider`** interface defined in hub; implementations live in
   players / `in-*` bindings (IDB non-synced, file, OS keychain). Hub stays
   portable — no Node/browser storage in kernel. Distinct from managed mode's
   `SealingKeyProvider` (which seals the whole secret); this seals only the
   echo reveal-blob. Naming kept distinct to avoid conflation.
6. **Enforcement by API shape**: `loadKeyring(secret: string)` throws
   `EchoCeremonyRequiredError` for echo keyrings; only the stepwise ceremony API
   unlocks them.
7. **Rotation/recovery are echo-shaped**: three new-secret fields, never one
   string (AG-1 through the back door otherwise). Tier-2 slots survive rotation
   via the existing `SlotRewrapCeremony` mechanism (cf. on-webauthn's).
8. **Tier taxonomy unchanged**: echo-secret IS tier-1 (derives the KEK); tier-2
   (webauthn/oidc slots) and tier-3 (PIN) enroll from an echo session exactly as
   from a plain one.

## Format

Optional, append-only `KeyringFile` extension — same migration-free playbook as
`canary` and `authenticators[]` (absent ⇒ legacy standard phrase):

```ts
// KeyringFile (kernel/types.ts); pod recipient slots inherit automatically
readonly echo?: {
  readonly v: 1
  /** Expensive-KDF verifier for the prompt — gates the reveal step. */
  readonly prompt_verifier: string
  readonly prompt_salt: string
  /** Hybrid reveal policy, chosen per slot at enrollment/writePod time. */
  readonly reveal:
    | { kind: 'portable'; blob: string; iv: string }   // blob = Enc(echo, KDF(prompt))
    | { kind: 'sealed'; provider_hint?: string }        // blob held by DeviceSealProvider
    | { kind: 'none' }                                  // verified 3-field entry
  /** Verifies a TYPED echo in the 'sealed'-without-provider / 'none' degradation. */
  readonly echo_verifier: string
  /** Optional display-masking hint; pure player-UI concern. */
  readonly mask_hint?: string
}
```

Visibility: the `echo` block is plaintext keyring metadata, consistent with `salt`
and `authenticators[].method` — it leaks "this vault uses a 3-part secret" and
nothing else. `BundleRecipient.secret` widens to
`string | { prompt: string; echo: string; key: string; reveal?: 'portable' | 'sealed' | 'none' }`.

## Ceremony (kernel state machine, UI-free)

```
start(prompt)
  ├─ prompt_verifier fails ............ WrongPromptError (counts toward on-threat lockout)
  └─ ok →
     ├─ reveal 'portable' ............. → REVEAL(echo plaintext)          [mutual auth]
     ├─ reveal 'sealed' + provider .... → REVEAL(echo plaintext)          [mutual auth]
     ├─ reveal 'sealed' w/o provider .. → REQUEST_TYPED_ECHO              [degraded]
     └─ reveal 'none' ................. → REQUEST_TYPED_ECHO              [degraded]
REVEAL → ownerConfirms() → AWAIT_KEY
REVEAL → ownerRejects() .............. PhishingSuspectedTerminal — ceremony dead,
                                        player MUST show the warning + rotate-in-official-app
                                        instruction; MUST NOT offer skip/fallback
REQUEST_TYPED_ECHO → echo_verifier ok → AWAIT_KEY (else WrongEchoError)
AWAIT_KEY → complete(key) → AG-1 KDF → KEK → canary check → standard session
```

Conforming-player contract (documented, enforced where the API can):
no single-field secret entry may exist for echo keyrings; the phishing-warning
terminal state is mandatory copy; no "skip verification" affordance.

## API surface (sketch — final names at implementation)

- `createNoydb({ secretMode: 'echo', deviceSeal? })`; enrollment collects three
  fields. `deviceSeal` absent ⇒ live keyrings enroll `reveal: 'portable'`;
  present ⇒ `sealed`. No other echo-specific options.
- `beginEchoUnlock(keyringFile, prompt)` → `EchoCeremony` handle exposing the
  state machine above; `ceremony.complete(key)` → `UnlockedKeyring`.
- `EchoCeremonyRequiredError`, `WrongPromptError`, `WrongEchoError` error classes.
- `rotateSecret` / `recoverSecret`: echo-shaped `newSecret` in echo mode.
- `validateSecret` / `assertStrongSecret`: per-part policy extension.
- `DeviceSealProvider` interface export.
- `/cargo` additions (if any orchestration-visible types): additive only — the
  cargo-surface golden test governs.

## Degradation matrix

| Context | Reveal kind | Ceremony grade |
|---|---|---|
| Enrolled device, provider wired | sealed | Full mutual auth + attacker-B resistance |
| Pod slot, default | portable | Full mutual auth, grade-A (static-clone) protection |
| Orphaned pod, owner opted `sealed`/`none` | — | Verified 3-field entry (structure, no reveal) |
| Legacy player, echo keyring | — | **Refuses**: `EchoCeremonyRequiredError`; cannot fall back to single-field |

## Constraints

- Kernel-surface ceilings (`collection.ts`/`vault.ts`/`noydb.ts`) are zero-slack:
  new code lands in `types.ts` + new enclave-area modules; shrink-first if a
  ceiling file must be touched.
- `pnpm check:architecture` green: hub-portable (no Node built-ins — hence the
  provider seam), no-crypto-deps (`crypto.subtle` only), stores-ciphertext-only
  (stores are untouched by this design).
- Manifest/Studio: the future access manifest **references** this declaration,
  never redefines it. Keyring-format work is pre-manifest kernel territory;
  linked from the Studio design gate when filed.
- Docs (noy-db-docs, on ship): `session-tiers.md` third mode; threat-model page
  attacker grading; `registry/features.yaml`; enrollment-guidance recipe.

## Testing

- TDD throughout. Unit: AG-1 KDF vectors (concatenation ≠ parts, separator
  injection, empty/unicode parts, length-prefix edge cases); verifier
  round-trips; state machine exhaustive transitions incl. both degradations and
  the phishing terminal.
- Property: no string `s` exists with `KDF_standard(s) == KDF_echo(p,e,k)` for
  the encoding (structural argument + spot vectors).
- Integration: enroll → tier-2 webauthn slot on top → rotate (slot survives via
  rewrap ceremony) → recover with echo-shaped input; pod round-trip: `writePod`
  echo recipient (each reveal kind) → `readPod` ceremony unlock; legacy-player
  simulation: string unlock throws.
- Simulation harnesses: add echo-mode cases to the multiuser/offline suites only
  if tier-1 unlock paths are exercised there (verify at implementation).

## Open questions — RESOLVED (2026-08-02, maintainer)

1. `prompt_verifier` hardness: **PBKDF2 600K, same iteration floor as the KEK.**
   The prompt gets **its own dedicated `SecretPolicy` floor** (it is the
   brute-forceable-in-isolation part — it must not be trivially guessable, since
   a guessed prompt yields the echo and enables a perfect phish for the key).
2. `mask_hint`: **stays optional in the format** (owner may set it at enrollment;
   players honor it when present, otherwise masking is their UI call).
3. `standard → echo` upgrade: **confirmed — rides `rotateSecret`** (old
   single-string secret in, three parts out), with tier-2 slots surviving via the
   `SlotRewrapCeremony` mechanism across the mode change.
4. Option shape: **`secretMode: 'echo'` alone — no `echoPolicy` bag.** One
   optional companion: `deviceSeal?: DeviceSealProvider`. When absent, live
   keyrings enroll `reveal: 'portable'` (same as the pod default, grade-A
   protection); supplying the provider is the explicit opt-in to `sealed`
   (attacker-B resistance). Mirrors the managed-mode `sealingKey` precedent.
5. Per-part validation: **the prompt gets the dedicated entropy floor** (per 1);
   echo is free-form (never typed on the normal path; longer = better as a
   recognition token). The existing whole-secret policy continues to apply to
   the combined parts, so the key is not left unvalidated (note: key entropy
   still matters against a file-holder who has brute-forced the prompt — the
   combined-policy floor is what covers it). **Anti-autobiography guidance is
   docs-only**, never a validator.

## References

- Issue #940 (arc capture), milestone #45.
- `packages/hub/src/kernel/types.ts` — `KeyringFile`, `secretMode`.
- `packages/hub/src/with-pod/bundle.ts` — `writePod`/`readPod`;
  `with-party/team/keyring.ts` — `BundleRecipient`.
- `packages/on-webauthn/src/index.ts` — tier-2 PRF wrap + `SlotRewrapCeremony`
  precedent.
- noy-db-docs `content/docs/services/session-tiers.md` — tier ladder + managed mode.
- Schechter, Dhamija, Ozment, Fischer (2007), *The Emperor's New Security
  Indicators* — why human-recognition checks fail under habituation.
