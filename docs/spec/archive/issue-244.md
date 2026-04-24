# Issue #244 — docs(conflict-resolution): cookbook — how to register a resolver, defaults, LWW vs merge-fields, multi-operator scenarios

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.2 — First adoption patch (pilot #1 feedback)
- **Labels:** type: feature, priority: high, pilot-1

---

Reported by pilot #1 (2026-04-23): *"ConflictPolicy and CollectionConflictResolver types are exported from hub, but the README does not document how to register one, what the default is, or when to pick last-write-wins vs merge-fields. Niwats multi-operator scenario (owner + staff operator editing same client) is blocked on this clarity."*

## Scope

Pure documentation. No code change.

## Deliverable

New doc `docs/patterns/conflict-resolution.md` covering:

1. **What conflict resolution means in noy-db** — OCC version mismatch at `expectedVersion` put; happens when two writers touch the same `(vault, collection, id)` without syncing first. Distinct from merge conflicts in git / CRDTs / text fields (those are handled by Yjs integration or manual).

2. **The default policy** — `"version"` → throw `ConflictError` on version mismatch. The caller decides what to do. **This is intentional** — noy-db does not guess which write wins for you.

3. **Built-in policies**:
   - `"version"` — throw on mismatch (default)
   - `"last-write-wins"` — newer `_ts` wins, older is overwritten
   - `"first-write-wins"` — older `_ts` wins, newer is rejected
   - `"manual"` — call a per-collection `CollectionConflictResolver` function

4. **How to register a resolver**:
   ```ts
   const db = await createNoydb({
     store: dynamo({ table: "myapp" }),
     user: "alice", secret,
     conflict: "manual",
   })
   db.registerConflictResolver("invoices", async ({ local, remote, base }) => {
     // Merge the two envelopes field-by-field; return the winner
     return { ...remote, amount: local.amount }
   })
   ```

5. **When to pick which**:
   - `"version"` for fiduciary data (accounting, contracts) — never silently lose a write
   - `"last-write-wins"` for UI state, draft flags, read/unread — writer order matters, not contents
   - `"first-write-wins"` for immutable-once-set fields — audit records, timestamps
   - `"manual"` + resolver for domain-specific merges — e.g. client profile where owner-edits override staff-edits on certain fields

6. **Multi-operator scenario (pilots driver)**: owner and staff-operator both edit the same client record. Concrete walkthrough: conflict is detected, staff-operators write rolls back with `ConflictError`, UI shows a merge dialog, resolver chosen, write retries with new `expectedVersion`.

7. **Sync and conflict** — how the sync engine uses the policy (push-time and pull-time). Cross-ref to `docs/guides/topology-matrix.md` Pattern E Team-sync peers.

8. **Cross-refs**:
   - Topology matrix Pattern E (team sync)
   - SPEC.md Sync Engine section
   - Showcase #04 sync-two-offices (already exercises conflict, currently with minimal commentary)

## Format

Same house style as `docs/patterns/email-archive.md` — problem statement, short answer, decision matrix (here: matrix of policies × use-cases), concrete code samples. Target: 300 lines, single file, link from START_HERE.md.
