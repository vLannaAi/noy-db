# Discussion #64 — Query DSL: joins across collections (using v0.4 refs as the anchor)

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** closed
- **Comments:** 2
- **URL:** https://github.com/vLannaAi/noy-db/discussions/64

---

The current query DSL is single-collection: `collection('invoices').query().where(...).toArray()`. Every consumer that needs to correlate records across two collections — invoice→client, order→product, comment→post, etc. — has to do the four-step dance:

1. Fetch one side's rows.
2. Extract the FK ids.
3. `get()` the other side per id (or load that whole collection).
4. Zip in JS.

This is correct but repetitive and it throws away an opportunity: **v0.4's `ref()` already declares the relationship at collection-construction time**. The schema the join would need is already on the `Collection`. A `.join(...)` call could resolve it without any new metadata.

Rough shape to anchor the discussion:

```ts
const invoices = company.collection<Invoice>('invoices', {
  refs: { clientId: ref('clients') },
})

const rows = invoices.query()
  .where('status', '==', 'open')
  .join('clientId', { as: 'client' })     // resolves via the existing ref()
  .toArray()
// → [{ id, amount, client: { id, name, ... } }, ...]
```

Open questions I'd like maintainer input on before anyone writes code:

1. **Eager vs lazy hydration.** Does `.join(...)` hydrate eagerly on `.toArray()`, or return a projection that defers per-row decryption until fields are accessed? Eager is simpler and matches how the DSL already works; lazy is more memory-friendly for wide joins.
2. **Live queries.** If either side of the join mutates, does `.live()` re-fire? Probably yes — implementation is a merged subscription over both collections' change streams — but the semantics around the right side *disappearing* (ref integrity mode is `strict` vs `warn` vs `cascade`) need to match the v0.4 FK behavior consistently.
3. **Memory ceiling.** Joining a 10k-row collection against a 30k-row collection in memory is fine. Joining two 100k-row collections is not. Where should the library draw the line? Hard error? Warn once? Streaming join via `scan()`?
4. **Ledger attribution.** Reads don't touch the ledger today, so joins shouldn't either — just want to confirm that stays true once joins arrive.
5. **No cross-compartment joins.** The isolation boundary is sacred per the guiding principles; joins stay within a single compartment. Worth stating explicitly so nobody proposes otherwise.
6. **Index usage.** Secondary indexes exist since v0.3. Should the join planner prefer index lookups on the right-side collection when the FK is indexed? If yes, that's most of the complexity.

Not proposing a fully-specified API yet — looking for "yes this is worth doing, and here's the rough shape we want" before opening a feature issue or an epic.

Relates to (but distinct from) a companion discussion on aggregations — both extend the query DSL, but the design trade-offs are independent. A separate discussion on a full SQL frontend is also worth having, for the same reason.


> _Comments are not archived here — see the URL for the full thread._
