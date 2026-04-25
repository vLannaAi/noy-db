# team

> **Subpath:** `@noy-db/hub/team`
> **Factory:** `withTeam()` *(planned — keyring stays in core for v0.25; team subsystem extraction tracked separately)*
> **Cluster:** F — Collaboration & Auth
> **LOC cost:** ~1,000 (off-bundle when not opted in)

## What it does

Multi-user grant / revoke / rotate for vault keyrings, magic-link viewer sessions, sub-permission delegation, and hierarchical permission tiers. Single-owner keyring (the core minimum to wrap a DEK) stays in the always-on core; this subsystem covers the "more than one user" surface.

## When you need it

- Vaults shared between two or more users with role-based access
- Time-boxed read-only viewer sessions (auditors, reviewers)
- Operators with a sub-permission delegated by an admin
- Hierarchical access (tiers 0..N where higher tiers see lower tiers but not vice versa)

## Opt-in

For v0.25 the multi-user surface is reachable directly via the always-on core API:

```ts
await db.grant('vault-name', { grantee: 'alice@example.com', role: 'operator', ... })
await db.revoke('vault-name', { grantee: 'alice@example.com' })
await db.rotateKeys('vault-name')
```

Magic-link helpers from `@noy-db/hub`:

```ts
import { writeMagicLinkGrant, readMagicLinkGrantRecord, ... } from '@noy-db/hub'
```

The `withTeam()` strategy will gate this surface starting v0.26; today setting up keyring/grant code is "free" if you don't import the symbols.

## API

- `db.grant(vault, opts)` — wrap a DEK for the grantee
- `db.revoke(vault, opts)` — remove access; cascades to delegations
- `db.rotateKeys(vault)` — generate new DEKs and rewrap for remaining members
- `db.changeSecret(vault, oldSecret, newSecret)` — passphrase change
- `issueDelegation(...)` / `revokeDelegation(...)` — sub-permissions
- Magic-link grant helpers — one-shot read-only viewer sessions

## Behavior when NOT opted in (post-v0.26)

- Grant / revoke / rotate / magic-link surfaces will throw with pointers
- Single-owner workflows continue to work via the always-on keyring

## Pairs well with

- **sync** — grants flow over sync; rotated DEKs propagate to peers
- **session** — token-based sessions enforce grant policies
- **history** — every grant / revoke writes a ledger entry

## Edge cases & limits

- Roles: `owner > admin > operator > viewer > client` (from CLAUDE.md). Owner and admin can grant/revoke; viewer and client are read-only
- Tiers (v0.18) layer on top of roles for hierarchical visibility
- Rotation re-encrypts wrapped DEKs but does NOT re-encrypt envelope `_data` — that would be O(records) and is reserved for future "deep rotation"

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/keyring.test.ts`, `__tests__/grant-revoke.test.ts`, `__tests__/magic-link-grant.test.ts`
