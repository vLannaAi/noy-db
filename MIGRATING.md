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
