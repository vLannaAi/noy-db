# Issue #62 — Allow admin to grant another admin (bounded delegation)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: feature, type: security, area: core

---

## Target package

`@noy-db/core`

## Problem

Per the README's role table, `admin` can grant `operator` / `viewer` / `client` but **cannot grant another `admin`** — only `owner` can. In any team larger than one, this forces every admin onboarding through the single `owner` principal, which:

- Creates a bottleneck on day-to-day operations when the `owner` holder isn't available.
- Makes lateral admin delegation (e.g. "senior admin onboards a peer admin for the same scope") impossible without escalating to `owner` every time.
- Keeps the single-owner bus-factor risk unresolved even when multiple trusted humans exist: you cannot pre-provision a backup admin without the owner being present.

## Proposed solution

Allow `admin` to grant another `admin`, with two guardrails:

1. **No privilege escalation.** The granted admin's `permissions` set must be a subset of the granting admin's permissions. Enforced at `grant()` time — attempting to widen throws `PrivilegeEscalationError`.
2. **Cascade on revoke.** When an admin is revoked, any admin *they* granted is either revoked (strict, default) or warned (configurable). The ledger already records the grantor `userId` per mutation, so the delegation tree is reconstructable.

```ts
// Previously rejected — should become valid:
await db.grant('C101', {
  userId: 'admin-2',
  displayName: 'Second Admin',
  role: 'admin',
  passphrase: 'initial-temp',
  permissions: { '*': 'rw' },  // must be ⊆ caller's permissions
})

// Cascade revoke (strict is the default):
await db.revoke('C101', { userId: 'admin-1', rotateKeys: true, cascade: 'strict' })
//   → revokes admin-1 AND every admin admin-1 granted
//   → rotates DEKs once
```

Shape notes:

- No envelope / on-disk format change. Each new admin wraps the existing DEKs under their own KEK the same way a new operator does today.
- No new crypto primitives. Reuses AES-KW wrap/unwrap.
- The ledger attribution fields already exist; this is a core ACL change, not a data change.
- Key rotation on cascade is O(records), same cost as any other revoke.

## Alternatives considered

- **Status quo + "add via owner" workaround.** This is the current state and the thing this issue is asking to fix. It doesn't scale past tiny teams.
- **Introduce a sub-role like `admin-delegate`.** More surface area than the actual gap; the permission-subset rule above gets the same safety without a new role.
- **Allow admin-grants-admin only with owner pre-authorization token.** Extra protocol step, no real safety benefit over the subset rule, and it puts the owner back in the critical path.

## Invariant compliance

- [x] Adapters never see plaintext — each admin wraps DEKs independently; adapters still see ciphertext only.
- [x] No new runtime crypto dependencies — reuses AES-KW and the existing keyring format.
- [x] 6-method adapter contract unchanged — this is a core-level ACL change; adapters are untouched.
- [x] KEK never persisted; DEKs never stored unwrapped — each admin derives their own KEK from their own passphrase.
