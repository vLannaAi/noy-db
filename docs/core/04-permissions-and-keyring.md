# Core 04 — Permissions & Keyring

> **Always-on. Single-owner keyring is the minimum to wrap a DEK.**
> Source of truth: `packages/hub/src/team/keyring.ts`

## What it is

Every vault carries a per-user keyring in `_keyring/<userId>`. The keyring file holds:

- The user's role (`owner` / `admin` / `operator` / `viewer` / `client`)
- Per-collection permissions (`{ collectionName: 'rw' | 'ro' | 'none' }`)
- Wrapped DEKs (one per collection the user can decrypt)
- The user's salt for KEK derivation

A vault can be opened only by a user whose keyring decrypts (passphrase / passkey / OIDC / magic-link / etc. — see the `on-*` packages).

## Roles

| Role | Default permissions | Can grant/revoke | Can export |
|---|---|:--:|:--:|
| `owner` | `*: rw` | Yes (all roles) | Yes |
| `admin` | `*: rw` | Yes (admin / operator / viewer / client) | Yes |
| `operator` | Explicit collections: `rw` | No | ACL-scoped |
| `viewer` | `*: ro` | No | Yes |
| `client` | Explicit collections: `ro` | No | ACL-scoped |

Multi-user grant / revoke / rotate / magic-link / delegation / hierarchical tiers live in the [team](../subsystems/team.md) subsystem. Single-owner workflows need none of that — the keyring core is enough.

## Single-owner flow

```ts
const db = await createNoydb({
  store: ...,
  user: 'me',
  secret: 'correct-horse-battery-staple',
})
// On first openVault, an owner keyring is created, salt generated,
// KEK derived, DEKs minted, all wrapped + persisted to _keyring/me.
const vault = await db.openVault('personal')
```

## Multi-user flow (preview — full surface in `withTeam()`)

```ts
// Owner grants Alice read-write on invoices
await db.grant('vault-name', {
  grantee: 'alice@example.com',
  role: 'operator',
  permissions: { invoices: 'rw' },
})

// Owner revokes Alice; remaining DEKs are rotated
await db.revoke('vault-name', { grantee: 'alice@example.com' })
```

## Permission check on every op

`Collection.get` / `put` / `delete` calls `hasAccess(keyring, collection, op)` before any I/O. A denied op throws `PermissionDeniedError` — the store never sees the request.

`Collection.export*` paths check `hasExportCapability(keyring, format)` — see [Cluster G — Operations](../subsystems/routing.md) and the `as-*` package family.

## Critical invariants

- **No vault without a keyring.** Even `encrypt: false` mode synthesizes a dummy single-owner keyring so the permission code path is uniform.
- **Wrapped DEKs are persisted; raw DEKs are not.** Even an attacker reading `_keyring/<user>` cannot decrypt without the user's passphrase.
- **Role rank**: `owner > admin > operator > viewer > client`. Used by `listAccessibleVaults({ minRole })`.

## See also

- [docs/subsystems/team.md](../subsystems/team.md) — multi-user grant/revoke/rotate
- [docs/subsystems/session.md](../subsystems/session.md) — token sessions on top of keyrings
- `packages/on-*/` — unlock methods (passphrase, WebAuthn, OIDC, magic-link, etc.)
- [SPEC.md § Roles](../../SPEC.md)
