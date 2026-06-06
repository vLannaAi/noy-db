## 0.1 → 0.2

### `@noy-db/in-pinia` reactive i18n (non-breaking, opt-in)

`@noy-db/in-pinia` now ships a reactive locale layer: `useNoydbI18n`
(active-locale store), `useI18nField` (reactive `pickLang`), and an
exported `useDictLabel`. **Non-breaking** — `defineNoydbStore` defaults to
`i18n: 'raw'`, so existing stores keep returning `{ [locale]: string }`
maps exactly as before. Resolution is strictly opt-in:

- **Display-only stores:** add `i18n: 'follow'` to resolve items to the
  global locale and re-render on `useNoydbI18n().setLocale(...)`.
- **Leave `'raw'` (the default)** for any store whose maps feed identity
  reads (joins/derivations reading `.th`), export/filing projections, or a
  per-cell bilingual toggle bound to the map. Resolve those at the edge
  with `useI18nField` / `useDictLabel`.
- **Locale-less vaults:** `setLocale` and `bindTo(uiLocaleRef)` are
  **state-only** by default — they never call `vault.setLocale`. Keep it
  that way (don't pass `setLocale`'s `syncVault`) so guard/MV/export reads
  stay raw. (#286)
- **`liveQuery` is not locale-aware yet.** On a `'follow'` store,
  `store.items` are resolved but `store.liveQuery(...).items` still carry
  raw `{ [locale]: string }` maps — resolve those rows at the edge with
  `useI18nField` / `useDictLabel`. (Tracked follow-up.)

### Shamir recovery

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
