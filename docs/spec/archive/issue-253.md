# Issue #253 — meta: Pilot 1 fast-lane tracker — 11 issues, 4 phases, ~7 weeks critical path

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** v0.15.2 — First adoption patch (pilot #1 feedback)
- **Labels:** type: chore, priority: high, pilot-1

---

## Pilot 1 fast-lane — 11 issues across 5 milestones

Reported by Pilot 1 (2026-04-23) as the ASAP blocker set for adoption. All 11 tagged with `pilot-1` + `priority: high`. Originating milestones preserved for long-term roadmap coherence — this tracker is the single view of execution order.

## Dependency-ordered phases

### Phase 1 — ship this week (docs only, zero code)

Both are documentation-audits of features that already exist in v0.12+. Pilot reported them as gaps; the fix is to document prominently + audit every entry point.

- [ ] **#241** `docs(schema)` — schema validator at `collection.put()` exists; document it + audit every entry point (v0.15.2)
- [ ] **#244** `docs(conflict-resolution)` — cookbook for ConflictPolicy + CollectionConflictResolver; default behaviour, LWW vs merge-fields, multi-operator scenarios (v0.15.2)

**Ships in v0.15.2 alongside the rest of the adoption-patch stream.**

### Phase 2 — design + independent features (1-2 weeks)

All parallelisable. No inter-blocks.

- [ ] **#249** `RFC(as-*)` — two-tier auth model (`canExportPlaintext` + `canExportBundle`); Q1–Q6 resolution. **Blocks #246 + every other as-\*** (Fork · As)
- [ ] **#240** `feat(core)` — `db.transaction(async (tx) => { ... })` multi-record atomic writes (v0.16.0)
- [ ] **#245** `feat(i18n)` — Thai fiscal-period primitives (BE-year + RD deadlines) as `@noy-db/locale-th` sibling package (v0.17.0)
- [ ] **#193** `feat(on-recovery)` — one-time printable recovery codes (Fork · On)
- [ ] **#220** `feat(on-shamir)` — k-of-n Shamir split of the KEK (Fork · On)

### Phase 3 — RFC-gated + ledger subsystem (2-3 weeks)

Starts after Phase 2 unblocks:

- [ ] **#246** `feat(as-xlsx)` — multi-sheet, dict-expanded Excel export (blocked by #249)
- [ ] **#201** `feat(ledger)` — period closure, seal records after close (v0.17.0)
- [ ] **#218** `feat(core)` — consent boundaries, per-access audit with `{ actor, purpose, consent_hash }` (v0.16.0; natural overlap with #201's ledger work — batch if possible)

### Phase 4 — follows period closure

- [ ] **#202** `feat(ledger)` — period opening, carry-forward balances (blocked by #201)

## Critical path

```
Phase 1 (this week)
    │
    ├─ #241 schema docs ────┐
    └─ #244 conflict docs ──┤
                            │
Phase 2 (parallel tracks, 1-2 weeks starting ~now)
                            │
    ┌─ #249 RFC resolved ───┼─── unlocks #246 in Phase 3
    ├─ #240 transactions ───┤
    ├─ #245 Thai fiscal ────┤
    ├─ #193 on-recovery ────┤
    └─ #220 on-shamir ──────┤
                            │
Phase 3 (2-3 weeks)         │
                            │
    ┌─ #246 as-xlsx ────────┤
    ├─ #201 period close ───┼─── unlocks #202 in Phase 4
    └─ #218 consent ────────┤
                            │
Phase 4 (shortly after Phase 3)
                            │
    └─ #202 period open ────┘
```

## Why not move them to a single "Pilot 1" milestone?

Original milestones preserve *conceptual* scope: v0.16.0 = "Advanced core", v0.17.0 = "Time partitioning & auditing", Fork · On = long-lived auth family, Fork · As = long-lived egress family. Bulk-moving the 11 issues to a new milestone would break those groupings and force a future un-bundling when the non-pilot issues in those milestones also need to ship. The `pilot-1` label serves the fast-lane tracking without destroying long-term organisation.

## Out-of-scope for this tracker

Other Pilot 1 feedback that's already shipped or being handled separately:
- Bulk operations (`collection.putMany`) — captured in earlier adoption-patch work
- `collection.subscribe()` — captured in earlier adoption-patch work
- `.noydb` bundle export — captured by the new `as-noydb` issue #252 in Fork · As (not Pilot-1-blocking per the pilot's list)

## Estimated ship dates (indicative, not commitments)

- Phase 1 → 2026-04-28 (≤1 week)
- Phase 2 → 2026-05-12 (2-3 weeks; RFC #249 is the long tail)
- Phase 3 → 2026-06-02 (3 weeks)
- Phase 4 → 2026-06-09 (1 week trailing Phase 3)

Total critical path: ~7 weeks end-to-end; most of Phase 2 parallelises with Phase 3 kick-off.

## How to help Pilot 1 while this ships

While Phase 2+ ships, Pilot 1 can unblock themselves for each workflow today:

| Workflow gap | Until the feature ships, do this |
|--------------|----------------------------------|
| Excel export (#246) | Follow the SheetJS pattern in `docs/patterns/as-exports.md` §"The pattern for today" — ACL-scoped, audit-entry-by-consumer, ready now |
| Transactions (#240) | Wrap multi-write workflows in an app-level try/catch + compensating put on failure; accept that partial-failure windows exist |
| Thai fiscal (#245) | Hand-rolled BE-year helpers as used in pilot today; migrate to `@noy-db/locale-th` when it ships |
| Period seal (#201) | App-level `period_closed: true` flag on records + validator that rejects puts on closed periods; migrate to hub-native closure when it ships |
| Conflict resolver (#244) | The types are already exported from `@noy-db/hub`; the cookbook just makes them findable. Types work today. |
