# @noy-db/on-pin

[![npm](https://img.shields.io/npm/v/%40noy-db/on-pin.svg)](https://www.npmjs.com/package/@noy-db/on-pin)

> Session-resume PIN quick-lock for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/on-pin
```

## What it is

Session-resume PIN quick-lock for noy-db — after a full passphrase unlock, a short-lived PIN (or a per-device biometric) re-unlocks the cached DEKs without re-typing the passphrase. PIN never replaces the passphrase; only resumes an already-unlocked session.

## Device-trust mode — "always safe to open on this device"

The package's second session-resume mode: the session DEKs are wrapped under a
**non-extractable, device-bound `crypto.subtle` key** persisted in IndexedDB
(as a CryptoKey *object*, via structured clone — its raw bits never exist in
JS), so the vault reopens on this device with **no user factor at all**. No
network, no prompt.

```ts
import { enrollDeviceTrust, resumeDeviceTrust } from '@noy-db/on-pin'

// After a real-factor unlock (passphrase, invite, OIDC) — never cold:
await enrollDeviceTrust(keyring, { vault: 'main', policy: await db.policy.getPolicy('main') })

// On the next cold start of this device:
const { keyring, resumeTier } = await resumeDeviceTrust('main')
// resumeTier is 3 by default — pass it to checkGate as the session's activeTier.
```

**Threat model — read before enabling.** This is a deliberate, opt-in trade:

- **The OS lock screen IS the factor.** Anyone holding the unlocked device
  opens the vault. Intended for mobile/embedded contexts (LIFF → detached PWA,
  kiosk, personal phone) where the device lock is accepted as the effective
  user factor and repeated prompts kill the offline UX.
- **Non-extractable key.** Malware must run *on the origin in the browser* to
  use the key; it cannot exfiltrate the key material itself.
- **Fail closed, never a lockout.** Storage eviction (browser data clear, iOS
  ITP) surfaces as the typed `DeviceTrustNotFoundError` → fall back to a
  real-factor unlock and re-enroll. The real factor always remains.
- **Enrollment requires an already-unlocked session** — device-trust is never
  a first-unlock factor.
- **Policy-gated.** The vault owner/admin forbids or tier-bounds enrollment via
  the `app:device-trust` gate; a resume yields a capped session tier (default
  3, below the passphrase tier) so sensitive gated ops still need a real
  factor.
- **Revocation.** `clearDeviceTrust()` kills it locally; keyring-side DEK
  rotation invalidates the cached wrapped DEKs cryptographically.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/vLannaAi/noy-db#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/on-pin`](https://github.com/vLannaAi/noy-db/tree/main/packages/on-pin)
- Issues — [github.com/vLannaAi/noy-db/issues](https://github.com/vLannaAi/noy-db/issues)
- Spec — [`SPEC.md`](https://github.com/vLannaAi/noy-db-docs/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
