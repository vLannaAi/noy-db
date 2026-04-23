# Issue #63 — Cross-compartment role-scoped queries: listAccessibleCompartments + queryAcross

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Problem

Compartments are the isolation boundary, and a single principal commonly holds grants across many compartments (multi-tenant apps, multi-project setups, multi-workspace tools). Today there is no API to:

1. **Enumerate** the compartments where the current keyring can unlock a given role or higher.
2. **Fan-out read** across those compartments in a single call.

Any consumer that wants to produce a **consolidated view spanning every tenant the caller is authorized for** has to hard-code the compartment list out of band and open them one by one — which duplicates authorization state the library already owns, and can't respond to newly granted compartments without the consumer tracking them separately.

Concrete scenario (generic multi-tenant): an operator holds `admin` on compartments `T1`, `T2`, `T7`. The app needs a consolidated cross-tenant summary (e.g. totals by month, per-tenant breakdown of a collection). There is no way to express "give me every compartment where I hold at least `admin`, then read collection `X` from each."

## Proposed solution

Two new core APIs, both strictly bounded by what the caller's keyring can already unlock:

```ts
// 1. Enumerate compartments the current keyring can unlock, filtered by role.
const accessible = await db.listAccessibleCompartments({ minRole: 'admin' })
// → [{ id: 'T1', role: 'admin' }, { id: 'T7', role: 'owner' }, ...]

// 2. Role-scoped fan-out over those compartments.
const rows = await db.queryAcross(
  accessible.map(c => c.id),
  async (comp) => {
    return comp.collection('invoices')
      .query()
      .where('month', '==', '2026-03')
      .toArray()
  },
)
// → flat array, each row tagged with its source compartment id
```

Key design constraints:

- **No existence leaks.** `listAccessibleCompartments` only returns compartments whose keyring the current principal can actually unwrap. Compartments the caller has no key material for are **not returned**, **not enumerated**, and **not confirmed to exist**. This means the API uses the local keyring index as its source of truth — no adapter round-trip that could otherwise be observed as "caller probed for compartment X".
- **No cryptographic merging.** Each compartment's decryption stays isolated. `queryAcross` is literally "open N compartments, run the callback, close them, concatenate the results" — it's a convenience wrapper, not a new sync primitive.
- **Per-compartment authorization still applies.** Each read goes through that compartment's schema, ACL, and ledger as if it had been opened directly. If a collection within a compartment denies the caller, that compartment's slice returns empty / errors, and the overall call surfaces which compartment failed.
- **Opt-in concurrency.** `queryAcross(..., { concurrency: 4 })` so large fan-outs don't serialize. Default conservative.

This is the minimum primitive needed to power any consolidated-report feature in a multi-tenant app where the tenant list is defined by the permission graph, not hard-coded.

## Alternatives considered

- **Consumer maintains its own `{principal → [compartments]}` index out of band.** Breaks zero-knowledge — the index leaks the principal-to-compartment mapping to whatever stores it. Also duplicates state the library already owns.
- **Single "root" compartment that shadow-references the others.** Defeats isolation; couples unrelated tenants; makes grant/revoke across tenants atomic when it shouldn't be.
- **Require the consumer to pass the compartment list explicitly to `queryAcross`.** This is actually fine *if* we also ship `listAccessibleCompartments`; otherwise the consumer has to re-derive the list from their own out-of-band store, which is the broken state we're trying to fix. The proposal ships both.

## Invariant compliance

- [x] Adapters never see plaintext — every read still goes through the per-compartment decryption path.
- [x] No new runtime crypto dependencies — this is pure orchestration over existing primitives.
- [x] 6-method adapter contract unchanged — adapters don't know `queryAcross` exists; core opens multiple compartments sequentially or in parallel using existing calls.
- [x] KEK never persisted; DEKs never stored unwrapped — each compartment still derives its own KEK from the caller's passphrase on open, and closes it normally.
