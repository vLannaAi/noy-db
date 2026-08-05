# Changelog — on-webauthn

## 0.6.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.2

## 0.6.0-pre.0

### Minor Changes

- docs(on-webauthn): correct non-PRF confidentiality claims

  Non-PRF WebAuthn cannot provide confidentiality — its wrapping key derives entirely from the credential's `rawId`, which is stored in the enrollment record, so the record self-decrypts with no authenticator involved. By default, enrollment/rewrap refuses this path (throws `WebAuthnPRFUnavailableError`). The new behavior:

  - New enrollments require PRF-capable authenticators, passphrases, or explicit opt-in via `allowNonPrfInsecure: true`
  - Non-PRF WebAuthn is reclassified as a presence/liveness gate, not a confidentiality factor
  - Existing non-PRF records continue to unlock for back-compat, but are documented as non-zero-knowledge
  - The `allowNonPrfInsecure` escape hatch is explicitly opt-in and documented

  Updated documentation:

  - Module header (index.ts): added caveat about non-PRF not providing confidentiality by default
  - `deriveKeyFromRawId` docstring: changed from "rawId may be observable" to "rawId IS the entire secret and is stored in the record — self-decrypting"
  - `@noy-db/on-webauthn` README.md: clarified PRF requirement for zero-knowledge guarantee
  - Root SECURITY.md threat model table: distinguished PRF-capable (enclave-bound, confidentiality) from non-PRF (presence gate, no confidentiality guarantee)

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0

## 0.4.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.12

## 0.4.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.11

## 0.4.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.10

## 0.4.0-pre.9

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.9

## 0.4.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.8

## 0.4.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.7

## 0.4.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.6

## 0.4.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.5

## 0.4.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.4

## 0.4.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.3

## 0.4.0-pre.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2

## 0.4.0-pre.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.1

## 0.4.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.0

## 0.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0

## 0.3.0-pre.13

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.13

## 0.3.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.12

## 0.3.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.11

## 0.3.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.10

## 0.3.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.9

## 0.3.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8

## 0.3.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7

## 0.3.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31

## 0.2.0-pre.5

Docs-only: pruned internal issue-tracker references from source comments (Track A comment-provenance prune). No code or public API change.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.16

## 0.1.0-pre.15

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.15

## 0.1.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.14

## 0.1.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.12

## 0.1.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.11

## 0.1.0-pre.9

### Features

- **`webAuthnSlotRewrapCeremony`** ([#56](https://github.com/vLannaAi/noy-db/issues/56)) — exports a `SlotRewrapCeremony` for WebAuthn slots, the long-promised filling for the `/* re-prove WebAuthn, return slot */` placeholder in hub's [#29](https://github.com/vLannaAi/noy-db/issues/29) `slotCeremonies` API. Until this helper, the answer to "rotate phrase without losing my biometric" was "rotate, then re-enrol Touch ID" — UX-equivalent but not atomic.

  ```ts
  import { rotatePassphrase } from "@noy-db/hub";
  import { webAuthnSlotRewrapCeremony } from "@noy-db/on-webauthn";

  await db.rotatePassphrase("acme", {
    oldPassphrase,
    newPassphrase,
    slotCeremonies: {
      "webauthn-yubikey": webAuthnSlotRewrapCeremony,
    },
  });
  ```

  Single ceremony, two crypto operations under one assertion: trigger one WebAuthn assertion → derive the wrapping key (PRF or rawId fallback, deterministic per credential) → decrypt the OLD `wrapped_kek` to extract identity carry-through fields (userId, displayName, role, permissions, salt — none of these change on phrase rotate) → build NEW payload with `ctx.newDeks` → encrypt with the same wrapping key under a fresh IV → return `EnrollAuthenticatorOptions` preserving `oldSlot.id` and `method: 'webauthn'` (anti-slot-swap defense).

  Helper lives in `@noy-db/on-webauthn` (NOT hub) per the peer-dep convention — hub importing on-webauthn would invert the dep graph. Out of scope: tier-3 PIN, which lives in `QuickUnlockStore` (RAM-only) not in `KeyringFile.authenticators[]`; clear PIN state on rotate and prompt the user via `db.enrollUnlock` immediately after.

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9

## 0.1.0-pre.8

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 0.1.0-pre.1 — Initial pre-release
