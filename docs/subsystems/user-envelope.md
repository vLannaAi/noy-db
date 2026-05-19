# user-envelope

> **Subpath:** none — included in always-on core
> **Factory:** none — exposed as `vault.user.*`
> **Cluster:** F — Collaboration & Auth
> **LOC cost:** ~600 (always-on; trivially small)
> **Spec:** `docs/superpowers/specs/2026-05-05-user-envelope-design.md`

## What it does

Per-principal user object: every keyring in a vault gets its own `_users/<keyringId>` envelope, encrypted under a shared `_users` DEK. The envelope holds whatever profile + preferences shape the app defines — hub commits only to `userId === keyringId` and the storage location. Three method families on `vault.user.*`:

- **Write-self** — `me() / updateMe(patch) / setMe(payload)`. Always target the writer's own keyringId; there is no API method to write someone else's envelope.
- **Read-anyone** — `get(keyringId) / list()`. Gated by `view-team-profiles` (default `minTier: 2`).
- **Reactive** — `subscribe(id, cb) / live(id)`. In-process event emission on local writes.

## When you need it

- A multi-user vault where each user wants their own UI preferences (theme, locale) that follow them across devices via the team/sync engine.
- A team-aware app rendering "who's online" or "who edited this record" with display names + avatars sourced consistently from one place.
- An accounting-style app where each user has a profile (signature, default currency map, per-client overrides) that travels with the vault.
- Admin onboarding flows that pre-fill a teammate's display name and locale at invite time.

## Opt-in

None — `vault.user` is always available on every `Vault`. The first write lazily provisions any state the underlying primitive needs:

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

const db = await createNoydb({ store: memory(), user: 'alice', secret: 'pass-2026' })
const vault = await db.openVault('demo')

await vault.user.updateMe({
  profile: { displayName: 'Alice' },
  preferences: { theme: 'dark' },
})
```

## API

### Write-self (own envelope only)

```ts
vault.user.me<T>(): Promise<UserEnvelope<T> | null>
vault.user.updateMe<T>(patch: DeepPartial<T>, presented?): Promise<UserEnvelope<T>>
vault.user.setMe<T>(payload: T, presented?): Promise<UserEnvelope<T>>
```

Each call goes through the `edit-own-profile` policy gate (default `minTier: 3`). Pass `presented: { factors, sharedDevice }` to satisfy tightened policies (e.g. `STRICT_POLICY` requires a TOTP for profile edits).

### Read-anyone

```ts
vault.user.get<T>(keyringId: string, presented?): Promise<UserEnvelope<T> | null>
vault.user.list<T>(presented?): Promise<UserEnvelope<T>[]>
```

`get(keyringId)` is gated by `view-team-profiles` *only when `keyringId !== self`* — reading your own envelope is never gated.

`list()` has a deliberate asymmetry on denial:

| Denial reason       | Behavior                                                  |
|---------------------|-----------------------------------------------------------|
| `disabled`          | Silent self-fallback — returns `[me]` only.               |
| `insufficient-tier` | Throws `PolicyDeniedError` (caller is expected to elevate)|
| `missing-factor`    | Throws `PolicyDeniedError`                                |
| `stale-proof`       | Throws `PolicyDeniedError`                                |

The `enabled: false` path is the privacy-strict opt-out ("nobody sees teammate profiles in this app"); the others are authentication concerns.

### Reactive

```ts
vault.user.subscribe<T>(keyringId: string, cb: (env: UserEnvelope<T> | null) => void): Unsubscribe
vault.user.live<T>(keyringId: string): LiveUserEnvelope<T>
```

Subscribers fire synchronously after every successful local `updateMe`/`setMe` on the matching keyringId. Pass `'*'` to fire on every change. Cross-instance changes (a teammate edits their profile on their device, the sync engine pulls onto this device) flow through the team/sync engine and will fire subscribers when sync replays the write through the API. In v1, raw store-level changes do not fire subscribers — wire your sync layer to call back through `vault.user.setMe`/`updateMe` if you need that behavior.

### Lifecycle hooks

```ts
db.grant(vault, { ..., initialProfile?: T })
```

Admin pre-fill at grant time. Hub seeds the new principal's first envelope under the caller's `_users` DEK so the new user can decrypt it on first open. Once the user activates and writes their own envelope, the own-only write rule prevents further admin edits — bootstrap-only by construction.

### Joined enumeration

```ts
import { listUsersWithEnvelopes } from '@noy-db/hub'
const rows = await listUsersWithEnvelopes<UserShape>(store, vault, dek)
// rows: Array<{ user: UserInfo; envelope: UserEnvelope<UserShape> | null }>
```

Convenience for admin UIs that want to render team-member lists with profile data in a single pass. Principals without a persisted envelope (legacy keyrings predating this feature) come back with `envelope: null`.

## Behavior when NOT opted in

`vault.user` is always present — there is no opt-in to skip. Vaults that never call `vault.user.*` work identically to today; the `_users` collection is reserved on grant but envelopes are empty until first `updateMe()`.

## Storage shape

Each principal has one envelope at the store key `(_users, <keyringId>)`. The envelope uses the standard noy-db form:

```json
{ "_noydb": 1, "_v": 7, "_ts": "2026-05-05T10:00:00.000Z", "_iv": "<base64>", "_data": "<base64 ciphertext>" }
```

`_data` decrypts (under the `_users` DEK) to an opaque JSON object. Hub does not reserve any keys inside the payload. The reference shape `{ profile, preferences, app }` lives in the `recipe-user-preferences` recipe as copy-paste material — apps adopt, modify, or replace it.

The `_users` DEK is **eager-provisioned** in `createOwnerKeyring()` for new vaults, and propagated to every granted keyring via the existing system-collection branch (`collName.startsWith('_')`) in `team/keyring.ts`. Pre-existing vaults (provisioned before this feature) get the DEK lazily on first `vault.user.*` access — see "Edge cases & limits" below.

## Permission model

Two new built-in policy gates, registered alongside the existing tier-2/tier-3 gates:

| Gate                | Default (PERSONAL)        | Default (STRICT)                                    | Purpose                                            |
|---------------------|---------------------------|-----------------------------------------------------|----------------------------------------------------|
| `edit-own-profile`  | `{ minTier: 3 }`          | `{ minTier: 2, factors: [{ anyOf: ['totp'] }] }`    | Authorize a write to one's own envelope.           |
| `view-team-profiles`| `{ minTier: 2 }`          | `{ minTier: 2 }`                                    | Authorize reading other principals' envelopes.     |

**Structural rules** (cannot be relaxed by policy):

1. `vault.user.updateMe` / `setMe` always target `writerKeyringId`. Runtime check throws `PermissionDeniedError` if the resolved target keyringId does not equal the writer's.
2. The API exposes no method that accepts a target keyringId for writes. There is no path by which an admin or owner can write a teammate's envelope.

**Tightening (allowed):**
- A strict app sets `edit-own-profile` to require a fresh TOTP for any profile change.
- A privacy-strict app sets `view-team-profiles.enabled: false` → `list()` returns only self; `get(other)` throws `PolicyDeniedError`.

**Relaxing (disallowed):**
- Setting `edit-own-profile` to permit cross-principal writes is impossible. Policy controls authentication, not authorization. The own-only rule is structural.

## Lifecycle

- **Created on grant.** When `team/grant.ts` provisions a new keyring, it also creates a `_users/<keyringId>` envelope, seeded with `initialProfile?: T` if present, else empty (`{}`).
- **Magic-link grants.** The existing `team/magic-link-grant.ts` is for **tier delegation** (auditor gets 48h access to a collection), not user creation; it does not produce a persistent keyring. Bootstrap `initialProfile` flows through `db.grant()` only.
- **Deleted on revoke.** Cascade-revoke removes the envelope alongside the keyring file. Idempotent: no error if the envelope is already absent.
- **Rotated on tier-1 rotation.** The DEK rotation path re-encrypts every `_users/*` envelope under the fresh DEK — the user-envelope feature inherits this for free since `_users` is in the affected collections set.
- **Untouched on tier-2 add/remove.** Authenticator slot changes do not touch the envelope.

## Pairs well with

- `team` — joined `listUsersWithEnvelopes()` for admin UIs; cascade-revoke deletes envelopes alongside keyrings.
- `session-tiers` — the `edit-own-profile` and `view-team-profiles` gates plug into the same policy-gate DSL (#9, #11).
- `sync` — own-write changes propagate to teammates' clients on the next sync round-trip; `subscribe()` fires when the sync layer replays the write through the API.
- `i18n` — apps storing `profile.locale` use it to drive `vault.t()` resolution.

## Edge cases & limits

- **Soft size cap: 64 KiB per envelope.** Larger payloads throw `UserEnvelopeOversizedError`. UTF-8 byte-aware (multi-byte characters are counted via TextEncoder, not `String.length`).
- **Pre-existing vaults — single-principal lazy DEK.** Vaults provisioned before this feature do not have a `_users` DEK in any keyring. The first call to `vault.user.*` lazily creates the DEK in *that user's* keyring only. Other principals on a different machine that open the vault later will then create their own (different) DEK — and cross-principal reads will fail until the vault rotates the keys. Workaround: call `db.rotate(vault, ['_users'])` after the first user calls `vault.user.*` to propagate the DEK to all keyrings. New vaults (post-feature) avoid this entirely via eager provisioning in `createOwnerKeyring()`.
- **Subscribe / live in v1 fire only on local writes.** Cross-instance changes flow via team/sync; subscribers there see the change when sync replays through the API. Wiring raw store-level changes into subscribers is a follow-up.
- **`UserProfileProvider` (managed-mode IdP integration) is documented but not exported in v1.** The interface shape is locked; runtime wiring lands post-1.0 alongside managed-passphrase mode (#14).

## Directory visibility

Two complementary opt-outs on top of `listUsersWithEnvelopes` (#122):

- **`vault.user.setMyVisibility({ hidden: true })`** — per-user opt-out.
  Persisted as a plaintext sidecar at `_meta/visibility/<keyringId>`.
  Hidden users are filtered out of the default listing; `owner`/`admin`
  callers can pass `{ includeHidden: true }` to see them. Own-only by
  construction (no method to hide another principal).
- **`db.setDirectoryEnabled(vault, false)`** — vault-level toggle.
  Owner-only. Persisted at `_meta/directory`. When disabled,
  `listUsersWithEnvelopes` throws `DirectoryDisabledError` for any
  caller whose role is neither `owner` nor `admin`.

Both flags live in `_meta` rather than inside the encrypted
`UserEnvelope<T>.data` payload — `data` is opaque-to-hub by contract,
and the directory filter must work even when an envelope decryption
fails (legacy keyrings predating the envelope feature, or a corrupted
envelope). Storing them as plaintext sidecars matches the
`_meta/policy` pattern documented in
[`plaintext-bypass.md`](./plaintext-bypass.md).

**Honest caveat — this is a UX flag, not a privacy guarantee.** The
keyring file at `_keyring/<userId>` is still listed (an attacker with
direct store read access can count keyrings and read role +
permissions metadata). The envelope ciphertext at
`_users/<keyringId>` is still present in the store. The visibility +
directory flags only gate the hub-level enumeration helper — they
prevent admin-UIs from accidentally rendering a hidden user, not a
determined adversary from learning who has access. Apps that need
real principal anonymity should use a dedicated identity store
external to the vault.

Peer-recovery preserves both flags: `db.recoverUser` only rewrites the
keyring file, so the user's visibility doc and the vault's directory
doc both survive the rotation.

## See also

- `docs/superpowers/specs/2026-05-05-user-envelope-design.md` — design spec
- `showcases/src/70-user-envelope.showcase.test.ts` — Hub API end-to-end
- `showcases/src/recipe-user-preferences.recipe.test.ts` — reference shape pattern + device-local pattern
- `docs/subsystems/session-tiers.md` — policy gate DSL the new gates plug into
- `docs/subsystems/team.md` — multi-user grant/revoke flows the lifecycle binds to
- `docs/subsystems/plaintext-bypass.md` — `_meta/directory` and `_meta/visibility/<keyringId>` are documented bypasses
