# Cross-vault DEK-grant executor identity — Insight Vault (#271)

> **Status:** ACCEPTED + BUILT (0.2.0-pre.19 cycle) — recommendation adopted:
> documented the service-account least-privilege pattern + shipped Hardening 2
> (Insight-write isolation guard). Hardening 1 (no) and 3 (defer) unchanged.
> **Context:** the Insight Vault (#271 Layer 4, PR #391) shipped with the
> derivation running under the **caller's** `Noydb`. This pins down the
> least-privilege production identity for that executor.

## Problem

`firm.refreshInsights()` reads each shard's records, derives a summary, and
writes it to the Insight Vault. v1 runs under whatever `Noydb` opened the
`VaultGroup` — typically the **bank admin**, whose keyrings can decrypt *every*
shard and write *everywhere*. That's a broad blast radius for a background
aggregation job: a compromised refresh process can read all client data and
mutate any vault.

The open question from the epic: does the executor run under the bank admin's
`Noydb`, or a **dedicated service account** with `role: 'operator'` grants on
exactly the source shards (read) and the Insight Vault (write) — least privilege?

## Current model (grounded)

- **Grants mint per-principal keyrings.** `db.grant(vaultId, { userId, role,
  passphrase, permissions })` writes a keyring envelope so a principal opening
  that vault under their passphrase receives exactly the granted collection DEKs
  (`noydb.ts:704`; `GrantOptions` at `types.ts:1072`, incl. per-collection
  `permissions`).
- **A `Noydb` IS an identity.** `createNoydb({ user, secret })` is "this
  principal, this passphrase." It holds only the keyrings it can unwrap; reading
  a shard requires a grant on it.
- **Missing grants already degrade gracefully.** The federation fan-out
  classifies a `NoAccessError` as a `'no-grant'` skip
  (`classifyShardSkip` / `resolveEligible`), so an executor lacking a shard's
  read grant simply skips that shard rather than failing.
- **Writes are actor-stamped.** Every envelope/ledger entry records `_by` =
  the writing principal's `userId`, so a service-account identity yields a clean
  audit trail distinct from human admins.

## Key realization

**The least-privilege model needs essentially no new hub code — it is a
deployment pattern.** "Run the derivation under a scoped service account"
means: open the `VaultGroup` under a `Noydb` constructed for a service-account
principal that has been `grant()`-ed:

- **read** on each shard's `source` collection (decryption requires only a read
  grant), and
- **write** on the Insight Vault's target collection — *and nothing else*.

```ts
// One-time provisioning (by an admin who holds owner on each vault):
for (const shardId of shardIds) {
  await admin.grant(shardId, {
    userId: 'svc-insights', displayName: 'Insight aggregator', role: 'operator',
    passphrase: SVC_PASSPHRASE,
    permissions: { collections: { invoices: ['read'] } },   // read-only on the source
  })
}
await admin.grant('firm-insights', {
  userId: 'svc-insights', displayName: 'Insight aggregator', role: 'operator',
  passphrase: SVC_PASSPHRASE,
  permissions: { collections: { 'client-summary': ['read', 'write'] } },
})

// The aggregation process runs as the service account:
const svc = await createNoydb({ store, user: 'svc-insights', secret: SVC_PASSPHRASE })
const firm = await svc.openVaultGroup('firm-clients', { sharding })
firm.withCrossVaultDerivation({ source: 'invoices', target: { vault: 'firm-insights', collection: 'client-summary' }, derive })
await firm.refreshInsights()    // reads only what it's granted; writes only the summary
```

A shard the service account isn't granted → `'no-grant'` skip (already handled).
Revoking the account's grant on a shard cleanly removes it from future refreshes.

## Decision

**Which is the supported model?**

- **(A) Caller's `Noydb` (v1, shipped).** Simplest; broad privilege. Fine for
  single-operator / dev.
- **(B) Dedicated service account (least privilege).** Recommended for
  production. Read-only on shards, write on the Insight Vault, nothing else;
  bounded blast radius; clean audit actor; graceful skip on revoked shards.

**Recommendation: document (B) as the production pattern; keep (A) as the
default. No core change required** — (B) is `grant()` + `createNoydb()` wiring.

Two small, *optional* hub hardenings to make (B) safer/ergonomic (each a yes/no):

1. **Read-only enforcement on the source.** Should `withCrossVaultDerivation`
   assert the executor's grant on `source` is read-only (reject if it also holds
   write)? *Rec: no* — least privilege is the operator's grant choice; the hub
   shouldn't second-guess a valid grant. Document instead.
2. **Insight-write isolation guard.** Should the engine refuse a `target.vault`
   that is also a *shard* of the group (preventing accidental write-back into
   client data)? *Rec: yes* — cheap invariant; a summary must never target a
   shard vault. Add a check in `withCrossVaultDerivation` /`refreshInsights`.
3. **A `db.grantServiceAccount(...)` convenience** that bundles the per-shard
   read + Insight write grants? *Rec: defer* — the explicit `grant()` loop is
   clear and flexible; sugar can come if pilots ask.

## Build (if approved)

- **Docs (always):** an "Insight Vault identity & least privilege" section in
  `docs/subsystems/vault-group.md` + the ZK note cross-link, with the snippet above.
- **Hardening 2 (if yes):** `withCrossVaultDerivation` throws if
  `target.vault === this.name` or matches `shardVaultId(any registered partition)`
  prefix — a `ValidationError`. ~10 lines + a test.
- No change to the refresh engine itself; (A) and (B) are the same code path
  under different identities.
