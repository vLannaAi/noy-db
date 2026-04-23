# Issue #73 — feat(core): Query DSL .join() — eager, single FK, hash + indexed nested-loop planner

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.6.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#64 — see [the maintainer position comment](https://github.com/vLannaAi/noy-db/discussions/64#discussioncomment-16476646) for the full design rationale and answers to the open questions.

## Problem

The current single-collection query DSL forces every consumer that needs cross-collection correlation to do the four-step "fetch / extract FK ids / per-id `get()` / zip in JS" dance. This is correct but repetitive, and it throws away the v0.4 `ref()` declaration — the relationship is already declared at collection construction time, but the DSL has no way to follow it.

A `.join()` builder method that resolves through the existing `ref()` is the right shape, requires no new schema or metadata, and brings the cross-collection correlation pattern inside the library where it can be tested once.

## Proposed solution

```ts
const invoices = company.collection<Invoice>('invoices', {
  refs: { clientId: ref('clients') },
})

const rows = invoices.query()
  .where('status', '==', 'open')
  .join('clientId', { as: 'client' })       // resolves via the existing ref()
  .toArray()
// → [{ id, amount, client: { id, name, ... } }, ...]
```

### Scope (this issue, v1)

- Single FK join — `.join('fieldName', { as: 'aliasName' })` resolves the ref declared on `fieldName` and attaches the joined record under `aliasName`
- **Eager hydration only** — `.toArray()` returns plaintext joined records, matching how the rest of the DSL works today
- **Equi-joins on declared `ref()` fields only** — no joins on undeclared fields, no non-equi joins
- **Same-compartment only** — cross-compartment correlation goes through `queryAcross` (#63)
- **Two planner paths**, auto-selected:
  - **Indexed right side** (FK target collection has the joined field in `indexes`) — O(1) per left-row index lookup
  - **Non-indexed right side** — classic hash join (build the right side once, probe per left-row)
- **Manual planner override** for tests via `{ strategy: 'hash' | 'nested' }`
- **Hard memory ceiling** at `JoinTooLargeError` — default `maxRows: 50_000` per side, override with `{ maxRows: 200_000 }`. Warn at 80%, error at 100%, with error message linking to the streaming-join issue.
- **Ref-mode behavior table** for dangling refs:
  - `strict` — reading a join row whose right side is missing throws `DanglingReferenceError`
  - `warn` — joined value is `null`, one-shot warning to the existing warn channel
  - `cascade` — N/A on read (only meaningful on delete)
- **Reads stay out of the ledger** — joins are reads, reads do not touch `_ledger/`

### Out of scope (separate issues)

- **Live mode** — tracked in the `.join() live mode` follow-up issue
- **Multi-FK chaining** (`.join('clientId').join('parentId')`) — tracked separately
- **Streaming join over `scan()`** for collections beyond the row ceiling — separate v2 issue
- **Lazy hydration** (`{ hydrate: 'lazy' }`) — wait for a real consumer ask
- **Cross-compartment joins** — explicitly forbidden (architecture invariant), use `queryAcross` (#63) instead

## Acceptance

- [ ] `QueryBuilder.join(field, { as, strategy?, maxRows? })` method
- [ ] Indexed-nested-loop planner used when the FK target field is declared in `indexes`
- [ ] Hash-join planner used otherwise
- [ ] `JoinTooLargeError` thrown when either side exceeds the row ceiling, with both row counts in the error
- [ ] `DanglingReferenceError` on `strict`, null + warn on `warn`
- [ ] Architecture-doc bullet: "Joins are intra-compartment. Cross-compartment correlation happens at the application layer over `queryAcross` (#63)."
- [ ] Tests covering both planner paths, the row ceiling, all three ref modes, and a same-compartment two-collection happy path
- [ ] Changeset (`@noy-db/core: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] Adapters never see plaintext — joins run after decryption, in core
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped
- [x] Zero new external dependencies

v0.6.0 candidate.
