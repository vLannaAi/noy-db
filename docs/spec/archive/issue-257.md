# Issue #257 — feat(delegation): cross-user KEK exchange for v0.18 #209 — follow-up

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-23

- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security, area: core

---

## Follow-up to #209 (v0.18 time-boxed cross-tier delegation)

The v0.18 landing (commit e2de8fe) shipped the \`vault.delegate()\` /
\`revokeDelegation()\` / \`loadActiveDelegations()\` surface and the
on-disk token shape, but the first-cut implementation wraps the tier
DEK against the **grantor's own KEK**, not the target user's. See the
status line in \`docs/v0.18-hierarchical-access.md\`:

> **#209 is first-cut only.** \`vault.delegate()\` currently wraps the
> tier DEK against the *grantor's own KEK*, not the target user's —
> so same-user token issuance and revocation works end-to-end, but
> genuine cross-user delegation still needs a KEK-exchange bridge.

## Scope

Implement one of the three cross-user KEK exchange paths:

1. **Magic-link bridge** (\`@noy-db/on-magic-link\`) — the grantor
   wraps the DEK against an ephemeral KEK derived from a signed URL;
   the target user clicks to claim within a bounded time window.
2. **OIDC bridge** (\`@noy-db/on-oidc\`) — on-issue, the grantor
   publishes the DEK against a KEK bound to the target's federated
   identity; target claim flow unwraps after federation auth.
3. **Shamir split** (\`@noy-db/on-shamir\`) — split the DEK into k-of-n
   shares addressed to multiple target KEKs.

## Acceptance

- \`vault.delegate({ toUser: 'alice', … })\` where \`alice\` is a
  **different** user than the grantor writes a usable token.
- Alice's \`loadActiveDelegations\` on next open unwraps it.
- Revoke (grantor side) removes Alice's access on next refresh.
- Tests cover cross-user path explicitly (not just same-user).

## Non-goals

- Changing the on-disk token shape (\`DelegationToken\` interface
  stays stable).
- Expanding the hub surface beyond the existing
  \`delegate\`/\`revokeDelegation\`/\`loadActiveDelegations\` trio.

The collection-level \`elevate\` / \`demote\` / \`getAtTier\` /
\`putAtTier\` / \`listAtTier\` methods are unaffected by this follow-up.
