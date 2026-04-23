# Discussion #66 — SQL query frontend — should noy-db ship one at all?

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** open
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/66

---

Filed as a **separate** discussion from joins/aggregations deliberately — those are extensions to an existing fluent DSL; a SQL frontend is a different abstraction with different trade-offs, and I think the answer might be "no, don't ship one." Worth having the position stated explicitly so consumers stop asking.

## What would it look like if shipped

A SQL parser + planner that lowers a restricted SQL subset onto the existing (or extended) query DSL:

```ts
const rows = await db.sql`
  SELECT i.id, c.name, SUM(i.amount) AS total
  FROM invoices i
  JOIN clients c ON c.id = i.clientId
  WHERE i.status = 'open'
  GROUP BY c.id
`
```

That looks nice on a slide. It's also the most dangerous feature any small embedded database can ship, for four reasons:

## Why I think the answer is probably "no"

1. **Grammar surface.** Even a 5% SQL subset is a parser, a planner, a type checker, and a long tail of edge cases (`NULL`, casts, subqueries, date semantics, string comparison collation, `IN` vs `= ANY`, parameterization, injection prevention). Every small-DB project that has added SQL has regretted the maintenance bill.

2. **Philosophical fit.** noy-db's pitch is "embedded, encrypted, zero server, your data on your device." SQL is almost universally associated with *server* databases. Shipping SQL confuses the positioning: consumers will expect a SQLite-class engine and get disappointed when the subset is smaller than they hoped.

3. **The alternative is cheap and already adequate.** If the fluent DSL has joins + aggregations + `groupBy` (see the two sibling discussions), a consumer who wants SQL can plug in a userland SQL layer (e.g. `alasql`) that reads from `.toArray()`. That's 20 lines of code in userland, zero library maintenance burden, and the user gets full SQL — not a restricted subset.

4. **Ecosystem signal.** Every comparable library in the README's "what's missing" table explicitly does *not* ship SQL: RxDB, Dexie, TinyBase, LowDB, PouchDB, Replicache. None of them. That's not an accident — they've all made the same call.

## Possible narrow exceptions worth discussing

The only scenarios where shipping SQL might be defensible:

- **A tagged-template `db.sql\`\`` helper that parses *only* `SELECT`, purely as syntactic sugar over the fluent DSL.** Small enough to maintain, limited enough to not be mistaken for "real SQL." Still, I'm not sure this is better than just teaching the fluent DSL.
- **An import tool** (`noy-db import --from sqlite file.db`) that parses CREATE TABLE / INSERT statements to bootstrap a noy-db compartment from an existing SQLite dump. This is really an *importer*, not a query interface, and would belong to v0.7 (developer experience) on the roadmap.

## What I'd like out of this discussion

An **explicit maintainer position** — yes / no / narrow-exception — so that the answer can be linked from future consumer questions, and so that nobody spends weekend hours on a parser without alignment.

My guess is the answer is *no* (or "yes but only as the narrow tagged-template sugar"), and the right outcome of this discussion is a short section in `ROADMAP.md` or `ARCHITECTURE.md` stating the position and pointing SQL-hungry consumers at userland adapters.


> _Comments are not archived here — see the URL for the full thread._
