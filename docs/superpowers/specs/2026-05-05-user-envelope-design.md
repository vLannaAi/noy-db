# User envelope (`_meta/user/<keyringId>`) — design

> Per-vault, per-principal user object: profile + preferences + free-form app data, encrypted with the vault DEK, lifecycle-bound to the keyring. Hub owns plumbing (storage, sync, history, lifecycle, permissions); apps own schema. Reference shape ships in a registered showcase as copy-paste material, not as a hub-imported type.

## Goal

Add a hub-level user record (`_meta/user/<keyringId>` envelope) that travels with the vault, carries app-defined profile and preference data, syncs across the writer's devices via the existing team/sync engine, and is structurally bounded to "owned by the principal it describes" — only the keyring whose principal id matches the envelope's id can write to it (no admin override). The `UserProfileProvider` interface is **documented but not exported in v1**, leaving room for a future managed-mode IdP-attribute integration without painting into a corner.

## Success criteria (acceptance)

- A logged-in user can call `vault.user.updateMe(patch)` and read it back via `vault.user.me()`.
- The same user on a second device sees the change after the next sync round-trip; the writer's own devices see it via the presence-channel fast path.
- A different user (admin, owner, or otherwise) calling `vault.user.set(otherKeyringId, …)` finds no such API; structural enforcement is type-level (the API doesn't exist) and runtime (write-path checks `writerKeyringId === targetKeyringId`).
- `team/grant.ts` and `team/magic-link-grant.ts` accept an optional `initialProfile?: T`, seeding the new user's first envelope.
- Cascade-revoking a keyring also deletes its user envelope; no orphans remain in `_meta/user/*`.
- Tier-1 passphrase rotation re-keys the envelope via the existing rotation path; tier-2 authenticator add/remove leaves it untouched.
- `view-team-profiles` and `edit-own-profile` policy gates are honored: apps can tighten the gates (e.g., add a TOTP factor for `edit-own-profile`); apps cannot relax `edit-own-profile` to permit cross-principal writes (structural rule, policy can only tighten).
- `pnpm validate:features` passes after registry entries land.
- Conformance tests pass on `to-memory` (sync semantics, history ledger, lifecycle binding, own-only write enforcement, policy gates, presence-channel propagation).

## v1 SCOPE — what's in

| Feature | In v1 | Notes |
|---|:---:|---|
| `_meta/user/<keyringId>` envelope storage | ✓ | Standard noy-db envelope, AES-GCM with vault DEK |
| `vault.user.*` API surface (`me`, `updateMe`, `setMe`, `get`, `list`, `subscribe`, `live`) | ✓ | Three families: write-self, read-anyone, reactive |
| Generic typing — `vault.user.me<T>()`, `vault.user.updateMe<T>(patch)` | ✓ | App-level type safety; hub validates only `userId` and JSON-serializability |
| Soft size cap — 64 KiB per envelope | ✓ | Generous; rejects accidental "stuff app state in here" anti-pattern |
| Sync via team/sync engine, last-writer-wins via `_v` | ✓ | Treated like a record |
| History/ledger entries on each update | ✓ | JSON Patch + hash-chained ledger, same as records |
| Optimistic concurrency via `_v` | ✓ | Same as records |
| Presence-channel fast path for own writes | ✓ | Optimization; correctness does not depend on it |
| Own-only write rule (structural + runtime) | ✓ | New authorization shape: single structural author |
| `edit-own-profile` and `view-team-profiles` policy gates | ✓ | Defaults: tier 3 / tier 2; apps can tighten via `_meta/policy` |
| Lifecycle bound to keyring grant/revoke | ✓ | Created on grant (optional `initialProfile?: T`), deleted on cascade-revoke |
| Magic-link bootstrap of `initialProfile` | ✓ | Payload travels in magic-link envelope, seeded on activation |
| `team/keyring.ts` extension — `listKeyringsWithUsers()` | ✓ | Joined enumeration; existing `listKeyrings()` stays raw |
| `team/presence.ts` extension — optional `displayName` in presence record | ✓ | App passes a `displayName` string when announcing presence; hub does not introspect envelope payload (consistent with (d) free-form schema) |
| Showcase `70-user-envelope` (vitest, in `showcases/src/`) | ✓ | Hub API surface: own-only writes, lifecycle, gates, presence join |
| Recipe `recipe-user-preferences` (vitest, in `showcases/src/`) | ✓ | Reference `UserEnvelope` shape (`profile`/`preferences`/`app`) + device-local pattern |
| `features.yaml` registry entries (feature `user-envelope` + showcase + recipe) | ✓ | CI gate validates paths and anchors |
| Subsystem doc `docs/subsystems/user-envelope.md` | ✓ | Anchor `user-envelope` in `SUBSYSTEMS.md` |
| Conformance tests on `to-memory` | ✓ | CRUD, lifecycle, own-only enforcement, sync, history, gates |

## v1 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `UserProfileProvider` implementation + export | post-1.0, paired with managed-passphrase mode | Interface shape documented in this design; nothing exported from `@noy-db/hub` in v1. Runtime wiring lands when managed mode lands. Tracks alongside #14 family. |
| Cross-vault user identity (one user across N vaults) | not on roadmap | Explicitly rejected in design discussion (OIDC-as-identity leaks plaintext to IdP; identity-vault concentrates breach radius). Per-vault is the v1 stance. |
| Hub-formalized device-local lane | not planned | Apps handle device-only state via localStorage at the app layer. Showcase demonstrates the pattern. With (d) free-form schema, "device-local" is not a hub concept. |
| Avatar blob storage convention | v1.x | Hub doesn't reserve `avatarRef` or any field name; apps may use `blob-set` references at app discretion. Showcase demonstrates one pattern. |
| Nuxt playground page (Vue + Pinia settings page) | v1.x | Per `project_v016_v017_priority` memory, playground deliverables follow advanced-core. Recipe in `showcases/src/` covers the API-level Vue patterns; the rendered playground page lands later. |
| Admin pre-fill *after* activation | not planned | Bootstrap-only. Once the user activates, admins cannot edit teammate envelopes. Structural rule, not negotiable. |
| Per-field history opt-out | not planned | YAGNI. History cost is bounded (~100 entries/year per power-user). Treat-it-like-a-record symmetry beats microoptimization. |

## Architecture

### Storage shape

Each principal has one envelope at `_meta/user/<keyringId>`. The keyring id is the principal id from the existing `team/keyring.ts` machinery.

The envelope uses the standard noy-db form — no special wrapper:

```json
{ "_noydb": 1, "_v": 7, "_ts": "2026-05-05T10:00:00.000Z", "_iv": "<base64>", "_data": "<base64 ciphertext>" }
```

`_data` decrypts (under the vault DEK) to an opaque JSON object — the app's payload. Hub does not reserve any keys inside the payload. The only structural commitment is that `userId === keyringId` (implicit; not a payload field, derived from the envelope key).

### API surface

Three families, exposed via the new `vault.user` namespace:

```ts
// Write — own envelope only
vault.user.me<T>(): Promise<UserEnvelope<T> | null>
vault.user.updateMe<T>(patch: DeepPartial<T>): Promise<UserEnvelope<T>>
vault.user.setMe<T>(payload: T): Promise<UserEnvelope<T>>

// Read — any principal visible in the keyring
vault.user.get<T>(keyringId: string): Promise<UserEnvelope<T> | null>
vault.user.list<T>(): Promise<UserEnvelope<T>[]>

// Reactive
vault.user.subscribe<T>(keyringId: string, cb: (env: UserEnvelope<T> | null) => void): Unsubscribe
vault.user.live<T>(keyringId: string): LiveValue<UserEnvelope<T> | null>
```

`UserEnvelope<T>` is a thin reader view:

```ts
interface UserEnvelope<T> {
  keyringId: string  // === userId
  data: T            // app-owned payload
  _v: number
  _ts: string
}
```

There is no `vault.user.set(otherKeyringId, …)`. There is no `vault.user.delete(keyringId)` — deletion is automatic via keyring cascade-revoke. The omission is intentional: the API surface is the structural enforcement of the own-only write rule.

### Schema philosophy

Hub commits only to the storage location and the implicit `userId === keyringId` rule. The payload `T` is fully app-defined. No schema validation beyond JSON-serializability and the soft 64 KiB size cap.

The reference `UserEnvelope` shape — `profile` / `preferences` / `app` — lives in the `recipe-user-preferences` recipe as copy-paste material. Apps can adopt, modify, or discard it. Hub never imports or references this shape; integrations (`@noy-db/in-vue`, etc.) operate on the generic `UserEnvelope<T>` and let apps render via per-app components.

This trades framework-level "render any user out of the box" for "hub commits to nothing it would have to maintain forever". Given the project's design culture (showcase-driven, `features.yaml`-coordinated), the showcase carries the behavioral contract while the hub carries only the structural one.

### Sync, history, versioning

Treated like a record:

- **Sync.** Goes through the existing team/sync engine. Conflict resolution: last-writer-wins via `_v`. Concurrent writes only happen when one user has multiple devices active simultaneously; in that case last-write-wins matches user expectation ("the most recent edit on any device is the truth").
- **History.** Each update produces a JSON Patch entry in the hash-chained record-version ledger, same path as records. Bounded cost: a power user toggling settings ~100 times/year produces ~100 ledger entries — trivial against typical record counts.
- **Versioning.** Optimistic via `_v`, same as records. `updateMe(patch)` reads current `_v`, applies patch, writes with `expectedVersion`; conflict throws `OptimisticConcurrencyError` (existing error type).

The single deviation from "treat it like a record" is the **presence-channel fast path for own writes**:

- When a keyring writes its own envelope, the change additionally rides the existing `team/presence.ts` ephemeral channel for instant cross-device feel.
- Teammates' clients receive it via normal sync on next tick.
- Implementation note: this is purely an optimization. Correctness does not depend on the presence channel — disabling it changes only timing, not semantics.

### Permission model

Two new built-in policy gates, registered alongside the existing tier-2/tier-3 gates from `0.1.0-pre.5`:

| Gate | Default | Purpose |
|---|---|---|
| `edit-own-profile` | `{ minTier: 3 }` | Authorize a write to one's own envelope. Active session sufficient. |
| `view-team-profiles` | `{ minTier: 2 }` | Authorize reading other principals' envelopes. Authenticated session. |

**Structural rules** (cannot be relaxed by policy):

1. `vault.user.updateMe` and `vault.user.setMe` always target `writerKeyringId`. Runtime check: the resolved target keyringId must equal the writer's keyringId, else `PermissionDeniedError`.
2. The API does not expose `vault.user.set(otherKeyringId, …)`. There is no method by which an admin or owner can write a teammate's envelope.

**Tightening (allowed):**
- A strict app sets `edit-own-profile` to `{ minTier: 2, factors: [{ anyOf: ['totp'], freshnessMs: 300_000 }] }` to require a fresh TOTP for any profile change.
- A privacy-strict app sets `view-team-profiles.enabled: false`; `vault.user.list()` then returns only the caller's own envelope.

**Relaxing (disallowed):**
- Setting `edit-own-profile` to permit cross-principal writes is impossible — policy controls authentication, not authorization. The own-only write rule is structural.

### Lifecycle

- **Created on grant.** When `team/grant.ts` provisions a new keyring, it creates an empty `_meta/user/<keyringId>` envelope. If the grant call carries `initialProfile?: T`, that payload is written instead of an empty one.
- **Magic-link bootstrap.** `team/magic-link-grant.ts` (shipped in `0.1.0-pre.4`) accepts an optional `initialProfile?: T`. The payload is stored encrypted in the magic-link envelope and seeded on first activation. Once the user activates, only they can write the envelope.
- **Deleted on revoke.** Cascade-revoke (admin revoking an operator/client/viewer) already deletes the keyring file; we extend the same code path to delete `_meta/user/<keyringId>`. No orphans.
- **Rotated on tier-1 rotation.** Tier-1 passphrase rotation re-keys the vault DEK; the envelope re-encrypts via the existing rotation path with no special handling.
- **Untouched on tier-2 add/remove.** Authenticator slot changes do not touch the envelope.
- **Lazy creation for pre-existing keyrings.** Vaults provisioned before this feature lands have no user envelopes. They are created lazily on first read or on next vault open (implementation choice — both are correctness-equivalent). Tests cover both paths.

### Team subsystem integration

Three small, additive extensions:

**`team/keyring.ts` — joined enumeration.**

```ts
export async function listKeyringsWithUsers(
  vault: Vault
): Promise<{ keyring: KeyringFile; user: UserEnvelope<unknown> | null }[]>
```

Existing `listKeyrings()` stays raw; the joined variant is opt-in for callers that need both.

**`team/presence.ts` — display name in presence.**

The presence record format gains an optional field:

```ts
interface PresenceRecord {
  keyringId: string
  online: boolean
  // ...existing fields
  displayName?: string  // app-supplied; hub does not introspect envelope payload
}
```

The hub does **not** read the user envelope to extract a display name — that would couple hub to a specific payload shape and contradict the (d) free-form schema decision. Instead, the presence-announce API gains an optional `displayName?: string` parameter that the app supplies (typically by reading its own typed `vault.user.me<MyShape>()` and passing `me.data.profile.displayName`). Apps that don't follow the showcase shape pass nothing; consumers see `undefined`. The recipe demonstrates the standard pattern.

**`team/grant.ts` and `team/magic-link-grant.ts` — initialProfile parameter.**

Both grant entry points accept an optional `initialProfile?: T`. Default omitted = empty envelope. The parameter flows through to the envelope-creation step in the same transaction as keyring provisioning.

No changes to `session/`, `history/`, `query/`, `bundle/`, `cache/`, or any store. Stores still see only ciphertext envelopes and don't need to learn about user records.

## Forward-compat: `UserProfileProvider` (documented, not exported in v1)

The interface shape is **documented in this spec** so a future implementation does not have to renegotiate. **Nothing is exported from `@noy-db/hub` in v1** — there is no `UserProfileProvider` type, no `userProfile` constructor option, no runtime hook. Apps cannot wire one in v1. Implementation lands post-1.0, paired with managed-passphrase mode (#14 family); at that point the type is added to `@noy-db/hub`'s public exports along with the `userProfile?: UserProfileProvider` constructor option.

This deferred-and-documented stance is consistent with (d) free-form schema — the hub's v1 surface stays minimal. Apps that want a `profileSource` discriminator today put it in their own payload shape; the showcase reference includes one as a convention.

```ts
interface UserProfileProvider {
  /** Read user attributes from the IdP (Cognito, Auth0, OIDC userinfo extension). */
  hydrate(userId: string): Promise<unknown | null>

  /** Write user attributes back to the IdP. */
  persist(userId: string, payload: unknown): Promise<void>
}

// Wired at vault creation, alongside SealingKeyProvider
createNoydb({
  store,
  passphraseMode: 'managed',
  sealingKey: myCognitoSealingProvider,
  userProfile: myCognitoProfileProvider,    // optional, only meaningful in managed mode
})
```

**Source-of-truth policy.** Vault remains authoritative; IdP is a hydration cache for fast first-paint and cross-vault sharing within the same IdP tenant. `vault.user.me()` returns vault data merged on top of `hydrate()` output, with vault winning on conflict. `vault.user.updateMe()` writes vault first, then asynchronously persists to IdP (best-effort; vault write is durable, IdP write retries on next session if it fails). This preserves zero-knowledge for the canonical record even if the IdP is compromised.

**No change to v1 surface.** Apps that do not pass `userProfile` see no behavioral difference. The interface is locked but inert.

## Showcases

Two new artefacts in `showcases/src/`, both vitest tests with rich JSDoc (matching the existing 00-69 numbered showcase pattern and the `recipe-*.recipe.test.ts` recipe pattern). Both registered in `features.yaml`.

### Showcase: `70-user-envelope.showcase.test.ts`

- **id:** `70-user-envelope`
- **path:** `showcases/src/70-user-envelope.showcase.test.ts`
- **demonstrates the Hub API surface end-to-end:**
  - Owner grants a viewer with `initialProfile: { profile: { displayName: 'Alice' } }`; viewer activates and reads their seeded envelope back.
  - Viewer calls `updateMe(patch)`; same-vault second instance reads the change back.
  - Cross-principal write attempt (`vault.user.set(otherKeyringId, …)` not in API; runtime check on alternative paths throws `PermissionDeniedError`).
  - Cascade-revoke deletes the envelope alongside the keyring.
  - `view-team-profiles` gate: default returns all visible envelopes; tightening to `enabled: false` makes `list()` return only self.
  - `team/keyring.ts → listKeyringsWithUsers()` joined enumeration.
  - `team/presence.ts` augmented presence record with `displayName` from envelope.
- **JSDoc anchors:** "What you'll learn", "Why it matters", "Prerequisites" (06-multi-user, 22-on-passphrase), "What to read next" (recipe-user-preferences, docs/subsystems/user-envelope.md), "Spec mapping" (features.yaml → features → user-envelope).

### Recipe: `recipe-user-preferences.recipe.test.ts`

- **id:** `recipe-user-preferences`
- **path:** `showcases/src/recipe-user-preferences.recipe.test.ts`
- **demonstrates the reference `UserEnvelope` shape pattern:**
  - The reference shape `{ profile: { displayName, avatarRef, locale, timeZone }, preferences: { theme, locale }, app: { …app-specific } }` defined as an app-level interface (not imported from hub).
  - Settings page write/read flow using `vault.user.updateMe<UserShape>(patch)` with the typed reader returned by `vault.user.me<UserShape>()`.
  - Avatar via `blob-set` ref (existing hub feature) — illustrates the "store the blob in the vault, reference by id" pattern.
  - Device-local state pattern: `lastOpenedCollectionId` and `tableColumnWidths` stored in localStorage at the app layer, **not** in the vault — demonstrating the "device-local doesn't go in the vault" rule.
  - Shows how `@noy-db/in-vue` and `@noy-db/in-pinia` consume `vault.user.live()` for reactive bindings (API only; rendered Nuxt page deferred to v1.x).
- **Diagram:** one Mermaid sequence diagram in the JSDoc showing own-write propagation (writer device → presence channel → other writer devices; writer device → team sync → teammate devices).

## `features.yaml` registry

One new top-level `features` entry, matching the existing schema (`name`, `cluster`, all empty-array fields populated, invariants as full sentences):

```yaml
features:
  - id: user-envelope
    name: Per-principal user envelope
    cluster: collaboration-and-auth
    spec: docs/subsystems/user-envelope.md#user-envelope
    subsystem_doc: docs/subsystems/user-envelope.md
    package: '@noy-db/hub'
    factory: 'vault.user'
    status: beta
    showcases:
      - id: 70-user-envelope
        path: showcases/src/70-user-envelope.showcase.test.ts
    recipes:
      - id: recipe-user-preferences
        path: showcases/src/recipe-user-preferences.recipe.test.ts
    playground_pages: []
    diagrams: []
    invariants:
      - 'own-only write rule: a keyring can only write its own _meta/user/<keyringId> envelope'
      - 'keyring-bound lifecycle: envelope created on grant, deleted on cascade-revoke'
      - 'vault is source of truth (in managed-mode IdP integration, IdP is hydration cache only)'
    related: [permissions, team, session-tiers]
```

CI gate (`pnpm validate:features` → `scripts/validate-features.mjs`) verifies all paths resolve, the spec anchor exists in `SUBSYSTEMS.md`, the showcase id matches its filename, and cross-references resolve to registered ids.

## Documentation

- **`docs/subsystems/user-envelope.md`** (new). Full subsystem doc: storage shape, API, sync semantics, permission model, lifecycle, integration, forward-compat hooks. Mirrors this design doc minus the scope tables.
- **`SUBSYSTEMS.md`** (extended). New section with anchor `#user-envelope`, brief overview, link to the subsystem doc.
- **`docs/HANDOVER.md`** (extended). One-line entry pointing to the new feature for cross-session continuity.
- **`ROADMAP.md`** (extended). Entry under the upcoming milestone.
- **`docs/packages/stores.md`** etc. — unchanged. The user envelope is a hub feature, not a package-family addition.

## Rollout

- **Greenfield.** No existing user data — this is purely additive. No migrations needed.
- **Default behavior unchanged.** Vaults that never call `vault.user.*` work identically to today.
- **New keyrings (post-feature):** envelope is created at grant time. Default content is the empty object `{}` if no `initialProfile` was supplied, else the `initialProfile` payload. The envelope always exists once the keyring exists.
- **Pre-existing keyrings (provisioned before this feature lands):** no envelope exists in `_meta/user/`. On first read via `vault.user.get(theirKeyringId)` or `vault.user.me()`, an empty envelope is materialized and persisted. Implementor may alternatively choose eager materialization at vault-open time; both paths are correctness-equivalent and tests cover both.
- **Peer-dep convention.** No new packages; the feature lands inside `@noy-db/hub`. No `peerDependencies` work.
- **Version target.** Hub minor bump. Sub-packages (`in-vue`, etc.) get patch bumps if their integration adds the joined-presence support.

## Testing

- **Unit (`to-memory`):**
  - Envelope CRUD: `me`/`updateMe`/`setMe`/`get`/`list`/`subscribe`/`live` happy paths.
  - Own-only write enforcement: writing a target keyringId that doesn't match the writer throws `PermissionDeniedError`.
  - Lifecycle: grant creates envelope; cascade-revoke deletes it; rotation re-keys it; lazy creation works for pre-existing keyrings.
  - Sync parity: write on device A propagates to device B (simulated via shared `to-memory` store).
  - History: each update produces one ledger entry with a JSON Patch.
  - Optimistic concurrency: stale `_v` write throws `OptimisticConcurrencyError`.
  - Policy gates: tightening `edit-own-profile` blocks writes that don't satisfy the new gate; tightening `view-team-profiles` to `enabled: false` makes `list()` return only self.
  - Magic-link bootstrap: `initialProfile` flows through the magic-link envelope and seeds correctly on activation.
  - Soft size cap: writes exceeding 64 KiB throw a sized error.
- **Integration (`to-file`):**
  - Lifecycle on real fs storage; cross-process sync via shared file path.
  - Bundle export/import roundtrip preserves envelopes.
- **Conformance:**
  - The user-envelope behavior is store-agnostic; existing `runStoreConformanceTests` is unchanged. A new `runUserEnvelopeConformanceTests` extends conformance for stores that have specific guarantees we want to verify (mainly `casAtomic` interaction with `_v`).
- **Negative-leak test:**
  - `describeAuthConfig` (shipped in `0.1.0-pre.5` per CLAUDE.md) introspection must not leak user envelope contents. Test asserts that a sanitized output never contains values from `_meta/user/*`.

## Open questions / explicit non-decisions

These are intentionally left to implementation rather than design — flagging them so the implementor knows they are open:

1. **Eager vs lazy envelope creation for pre-existing keyrings.** Both paths are correctness-equivalent. Implementor picks one (or both with a flag) based on perf measurements.
2. **Soft size cap value (64 KiB).** Negotiable. Implementor may propose a different value with rationale.
3. **`UserEnvelope<T>.data` vs flattening `T` onto the envelope.** Two ergonomic shapes; both are valid. Implementor picks based on TS DX considerations.
4. **Subscribe/live channel coupling.** Whether `subscribe` uses the same internals as `live` (the query DSL `LiveValue`) or a separate lightweight implementation. Decision can be made in the implementation phase.
5. **Empty envelope encoding.** Whether the empty envelope's `_data` decrypts to `{}` or `null`. Implementor picks; either is fine, just be consistent.

## References

- `CLAUDE.md` — project overview, three-tier auth, policy gates, peer-dep convention
- `SPEC.md` — primary spec (anchor for the new section)
- `SUBSYSTEMS.md` — subsystem index (anchor `#user-envelope` to be added)
- `docs/subsystems/session-tiers.md` — three-tier authentication design (this design plugs into the policy-gate DSL)
- `features.yaml` — registry (this feature adds one `features` entry with one showcase + one recipe nested under it)
- `packages/hub/src/team/keyring.ts` — extended with `listKeyringsWithUsers()`
- `packages/hub/src/team/presence.ts` — extended with optional `displayName`
- `packages/hub/src/team/grant.ts` — extended with `initialProfile?: T`
- `packages/hub/src/team/magic-link-grant.ts` — extended with `initialProfile?: T`
