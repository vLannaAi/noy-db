# Changelog — on-webauthn

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
  import { rotatePassphrase } from '@noy-db/hub'
  import { webAuthnSlotRewrapCeremony } from '@noy-db/on-webauthn'

  await db.rotatePassphrase('acme', {
    oldPassphrase, newPassphrase,
    slotCeremonies: {
      'webauthn-yubikey': webAuthnSlotRewrapCeremony,
    },
  })
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
