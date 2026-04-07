---
"@noy-db/core": minor
---

Allow `admin` to grant another `admin` — bounded lateral delegation (closes #62).

The v0.4 rule was "only `owner` can grant `admin`," which bottlenecked every admin onboarding through the single owner principal. In any team larger than one, that made lateral delegation impossible and left a single-owner bus-factor risk unresolved even when multiple trusted humans existed. v0.5 opens up admin↔admin lateral delegation with two guardrails wired in from day one.

### What's new

```ts
// Previously rejected with PermissionDeniedError — now works:
await adminDb.grant('C101', {
  userId: 'admin-2',
  displayName: 'Second Admin',
  role: 'admin',
  passphrase: 'initial-temp',
})

// New: cascade-on-revoke. Revoking an admin who granted other admins
// automatically revokes the whole delegation subtree in one call.
await ownerDb.revoke('C101', {
  userId: 'admin-1',
  rotateKeys: true,
  cascade: 'strict', // default
})

// Diagnostic mode: leave the descendants in place but log them.
await ownerDb.revoke('C101', {
  userId: 'admin-1',
  cascade: 'warn',
})
```

### Guardrails

**1. No privilege escalation — `PrivilegeEscalationError`.**

`grant()` now validates that every DEK wrapped into the new keyring comes from the grantor's own DEK set. A grantor cannot give the grantee access to a collection they themselves can't read. Throws the new `PrivilegeEscalationError` with the offending collection name.

Under the v0.5 admin model this check is structurally trivially satisfied — admin grants always inherit the full caller DEK set by construction — so the error is currently unreachable in typical flows. It is wired in so that future per-collection admin scoping work (tracked under v0.6+ deputy-admin) cannot accidentally bypass the subset rule. The guard is already there; future code just has to preserve it.

`PrivilegeEscalationError` is exported from `@noy-db/core`:

```ts
import { PrivilegeEscalationError } from '@noy-db/core'

try {
  await db.grant(...)
} catch (e) {
  if (e instanceof PrivilegeEscalationError) {
    console.error(`Cannot grant access to ${e.offendingCollection}`)
  }
}
```

**2. Cascade on revoke — `RevokeOptions.cascade`.**

When an admin is revoked, every admin they (transitively) granted is either revoked too (`cascade: 'strict'`, default) or left in place with a `console.warn` listing the orphans (`cascade: 'warn'`). The walk uses the `granted_by` field already recorded on every keyring file as the parent pointer — no format change.

A **single key-rotation pass at the end** covers the union of affected collections across the cascade. Cost is O(records in affected collections), not O(records × cascade depth): every descendant's collections are unioned into one set before the rotation runs, so each affected record is re-encrypted exactly once regardless of how deep the cascade went.

The cascade walks only admin descendants. Operators, viewers, and clients in the tree are untouched by the cascade (they cannot grant other users, so they have no delegation subtree) — they stay in their current keyring files until manually cleaned up or until the rotation pass removes their collection DEKs.

Cycles introduced by re-grants (admin-A revoked, then re-granted later by someone admin-A had originally granted) are handled with a visited set and terminate cleanly.

### What's unchanged

- **Owner is still unrevocable.** No role can revoke `owner`, including a newly-promoted admin via the new delegation path.
- **No envelope / on-disk format change.** Each new admin wraps the existing DEKs under their own KEK the same way a new operator does today.
- **No new crypto primitives.** Reuses AES-KW wrap/unwrap.
- **The 6-method adapter contract is unchanged.** Adapters are not touched.
- **`canRevoke(owner, anything)` is still `true`.** Owners retain absolute revoke authority over every non-owner role.

### Tests

12 new tests in `packages/core/__tests__/admin-delegation.test.ts`:

- **Grant capability** — admin can grant admin, the granted admin can unlock the compartment and read records, the granted admin can transitively grant a third admin, admin → operator/viewer/client still works.
- **`PrivilegeEscalationError` class** — exported, right shape, distinct from `PermissionDeniedError`.
- **Cascade-strict** — full subtree revoke, independent chains untouched, non-admin descendants unaffected.
- **Cascade-warn** — descendants left in place, single `console.warn` lists every orphan by id.
- **Owner unrevocable** — newly-promoted admin via delegation path still cannot revoke owner.
- **Peer revoke** — admin-1 can revoke admin-2 when both were granted by owner (sibling, not ancestor).

One test in `access-control.test.ts` updated: "admin cannot grant admin" (v0.4 rule) → "admin can grant another admin (v0.5 #62)".

Full core suite: 403 tests passing.

### Documentation updated

- `NOYDB_SPEC.md` role table — "admin" grant column now reads "admin, operator, viewer, client"; new section explaining the two guardrails.
- `docs/architecture.md` permission matrix — `↓ roles*` footnote explains admin lateral delegation + cascade.
- `docs/getting-started.md` and `docs/noydb-for-ai.md` role tables — updated to reflect the v0.5 rule.
- `CLAUDE.md` role table — same update so future sessions have the current rules in context.

Part of v0.5.0.
