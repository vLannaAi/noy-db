## 0.1 → 0.2

**Breaking:** `@noy-db/hub` no longer re-exports the Shamir share codecs, and
Shamir recovery now requires an injected provider.

1. If you imported `encodeShareBase32` / `decodeShareBase32` from `@noy-db/hub`,
   import them from `@noy-db/on-shamir` instead.
2. If you use `profile: 'shamir'` recovery, pass the provider:
   ```ts
   import { shamirRecoveryProvider } from '@noy-db/on-shamir'
   const db = await createNoydb({ store, shamirRecovery: shamirRecoveryProvider() })
   ```

> Note: when multiple Shamir recovery entries are enrolled, supply the shares for a **single** entry per recovery attempt (optionally with `entryId`). Mixing shares from different entries in one call no longer recovers.

> Managed-passphrase mode mandates a strong recovery profile, and Shamir is the only one — so **managed-mode vaults now also require a `shamirRecovery` provider**. Add `@noy-db/on-shamir` and pass `shamirRecovery: shamirRecoveryProvider()` to `createNoydb`.

> **Bundle auto-unlock generalized (#215):** `autoCredentials` / `sealedCredentials` carry `{ kind: 'passphrase' | 'password' | 'pin', value }`, so a delivered bundle can one-click-unlock whatever tier the user enrolled. `autoPassphrases` / `sealedPassphrases` still work (deprecated sugar for `kind: 'passphrase'`). On read, `autoUnlock.perUser[user]` is now `{ kind, value }` — dispatch your login by `kind` (PIN is a prefill, not an enrollment). WebAuthn is not auto-unlockable (hardware-bound) and is rejected at write time. Pre-0.2 bundles read back unchanged (bare-string entries coerce to `kind: 'passphrase'`).
