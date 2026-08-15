# `withVaultHead()` — detecting a store that withholds

> `@noy-db/hub/vault-head` · opt-in · #1044 · ADR 0003 Decision 3

## What it is for

A record's envelope authenticates itself. Since #1041 its identity —
collection, id, tier, author — is bound into the AEAD, so an untrusted store
cannot relocate it, re-tier it down, re-author it or splice another body into
it. Since #1042 the sync merge rejects one that fails to authenticate *before*
committing it.

Neither can see **absence**.

A store serving a genuine, unmodified `v1` when `v7` exists is serving a real
record that this client really wrote. Nothing about the bytes is wrong. A store
serving *nothing* is likewise indistinguishable from a record that never
existed. Both attacks are invisible to per-envelope authentication, by
construction — you cannot detect a missing thing by examining the things
present.

The head is the missing external knowledge: an authenticated `{id → version}`
manifest the client writes and the store cannot forge.

## Why it is opt-in when AAD is not

AAD costs nothing to coordinate and closes *alteration*, so it is kernel and
unconditional. The head costs a write per commit and needs anti-entropy. On a
single-device offline vault it defends against nothing — there is no second
party to withhold anything. Making it kernel would tax every user for a
multi-writer property.

This split is what lets `SECURITY.md` make a narrower **true** statement instead
of a concession:

> A remote store — or a `by-peer` peer — **cannot alter, relocate, re-tier,
> re-author or rewind any record it serves.** Without `withVaultHead()`, it can
> still **withhold** or **omit**.

## Using it

```ts
import { createNoydb } from '@noy-db/hub'
import { withVaultHead, verifyVaultHead } from '@noy-db/hub/vault-head'

const head = withVaultHead()
const db = await createNoydb({ vaultHeadStrategy: head, store, user, secret })
const vault = await db.openVault('acme')

// …writes proceed normally; the head records each one …

const { adapter, getDEK } = vault._introspectState()
const result = await verifyVaultHead(head, adapter, 'acme', getDEK, 'invoices')
if (!result.clean) {
  for (const d of result.discrepancies) {
    // d.kind === 'withheld'    → the store serves nothing for a record we wrote
    // d.kind === 'rolled-back' → it serves an authentic OLDER version
  }
}
```

## Shape: bucketed, and why that is not a compromise

ADR 0003 left head granularity open and asked for it to be sized early, because
*"shape decisions are cheap now and expensive later"*. Measured at the
documented 50K-record vault ceiling:

| shape | write cost per commit | detection |
|---|---|---|
| one per-vault manifest | **1.1 MiB** | per-record |
| one per collection | the same problem, renamed | per-record |
| **bucketed, 256 buckets** (default) | **~4.4 KiB** | per-record |

Bucketing changes *only* write amplification. Each bucket still lists every one
of its records' versions, so detection stays per-record — this is not a trade of
cost against strength. Verifying one pulled record reads one bucket rather than
a megabyte.

`buckets` is a **layout** decision, not a tuning knob: changing it on an existing
vault re-homes every entry.

## What it deliberately does not report

- **A record the head never saw.** The head can be enabled on an existing vault,
  and every pre-existing record would otherwise read as an anomaly. Its claim is
  one-directional: *what I wrote must still be there.*
- **A version HIGHER than expected.** Another device legitimately advanced it.
  The head detects going backwards, not moving forwards.

## Properties worth knowing

- **Buckets are ordinary encrypted records**, so they inherit #1041's identity
  binding: a store cannot relocate a bucket or serve one bucket's bytes as
  another's. Record ids never appear in the clear.
- **`note()` is monotonic.** An entry never moves backwards. A stale retry or a
  replayed write must not be able to launder a rollback through the client's own
  head — the sweep would then stop expecting the newer version, and the omission
  would become invisible.
- **Deletes are tracked too.** A head that forgot deleted records would let a
  store resurrect one by withholding the tombstone.
- **Not opted in costs nothing.** No observer is registered at all, so the write
  path's `hasHandlers` gate stays false.

## Limits

- **Anti-entropy is the client's own store.** The head lives in the same vault,
  so a store that rolls the *head* back is bounded only by the client's local
  copy being trusted. A fully cold device with no local state cannot detect a
  consistently old world — the store presents a coherent past. That is
  withholding at the vault level, and closing it needs an external anchor.
- **The sweep is per-collection and reads every bucket.** It is an audit
  operation, not something to run on each read.
