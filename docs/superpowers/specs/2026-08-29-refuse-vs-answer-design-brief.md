# Design brief: where a check REFUSES vs where it quietly ANSWERS

> **Status:** brief only — no decisions taken. Written 2026-08-29 so the five
> questions below are decided in ONE pass. Each has been reopened or
> re-derived at least once already; taken as five tickets they will be
> reopened five times, because they share a premise rather than a component.

## The shared premise

Every item here is the same question wearing different clothes: **when hub
cannot honour a declaration, does it refuse, or does it return an answer that
looks like data?**

The project's standing rule says a degraded state must never render as a
healthy one. These five are the places where it currently does — or where the
answer differs between two paths for no recorded reason.

They are not five bugs. Four are decisions; one (#1269) is a bug whose FIX
shape depends on the decision.

---

## 1. Guard placement — registration vs `describe()`

**The asymmetry, measured:**

| guard | fires at | if you never call it |
|---|---|---|
| `triggerBy` match fields (#1249, #1266) | `vault.collection()` | n/a — always fires |
| `fieldMeta` keys (#1253) | `describe()` | silent forever |

**Evidence.** The pilot's adoption of composite `triggerBy` was REFUSED at
startup with the field named — that refusal is why they did not ship a fan-out
that would have matched nothing. A typo'd `fieldMeta` key on a collection
nobody describes is silent indefinitely, and `fieldMeta` is what carries PII
classification.

**The real cost of moving `fieldMeta` to registration** is TS-generic
collections: with no readable field set there is nothing to check, so those stay
unguarded either way. The choice is therefore between *"guarded at registration
where we can, never where we cannot"* and *"guarded only if you remember to
describe"*.

**Consumer vote on record:** registration for both.

**Note the third position** that #1266 established and which neither guard uses
consistently: a VIRTUAL-field refusal needs no schema at all, because
"declared, and never stored" is provable from the declaration alone. So there
are three tiers, not two — always-checkable, checkable-with-a-schema, and
uncheckable.

## 2. #1269 — `groupBy` answers where `where()` refuses

Same virtual field, same apparent query layer:

```
query().where(virtual, …)      THROWS FieldNotQueryableError
MV query-form groupBy(virtual) SILENT — key `undefined`, row counted
MV unionSources map(r)         SILENT — field absent from the stored record
```

Controlled by the reporter (stored-key control on the same config materialises
correctly), so the silence is attributable to the field.

**Decision needed:** refuse at MV registration (matching #1266) or at compute
time. Registration cannot see a `unionSources` map's internals; compute time
can, but reports later.

`with-materialized-view.ts:57` calls this a "stored-field groupBy", which reads
as a claim the case is handled. It is not. **That comment misled this author
into inferring the wrong answer and stating it to a consumer** — worth fixing
whatever else is decided.

## 3. Mapped `match` — one declared hop off an existing `refs` edge

Consumer-proposed, with the case made rather than asserted. Their FK topology
needs a hop `match` deliberately lacks: `bills.entityId` ← `client.entityId` /
`client.id` → `disbursements.clientId`. Only `cycle` pairs cleanly.

**Why the workaround is not free:** a stored `clientId` on a bill is a second
copy of something the vault can already resolve, and a partial backfill goes
quiet on exactly the oldest, least-audited rows — which is the failure
`triggerBy match` was built to remove, reintroduced by the workaround.

**Shape proposed:** one declared hop off an existing `refs` edge, one lookup per
PARENT WRITE, not per candidate row. Explicitly not a general join in a write
hook.

**Not blocking:** they can carry their current `touchAffected` (seven re-put
call sites, each a real re-encrypt) indefinitely.

## 4. #1268 — the floor bundle's tolerance cannot discriminate

A 5% tolerance on a ~500-byte number is ~25 bytes. Registration-path validation
lands inside it. The gate has now fired twice on necessary validation (#1249,
#1266) and never on a subsystem leak, which is what it exists to catch.

Measured: editing `registry.ts` alone — `vault.ts` reverted — moves the floor,
so registry code is statically reachable from the floor entry chunk.

**Two candidate answers:** make the registry unreachable from the floor entry
(restores the gate's discriminating power), or give the floor row an absolute
byte allowance instead of a percentage.

## 5. `rowKey is required` reports the wrong condition

`withMaterializedView` throws `rowKey is required (no default)` when `rowKey`
is present but a STRING rather than a function. The message names ABSENCE; the
condition is WRONG TYPE. Cost this author three attempts and contributed to a
probe that measured nothing.

Smallest item here, same family: the error collapses two states that warrant
different responses.

---

## What ties the decisions together

Decide #1 first. It sets the principle — *refuse as early as the information
allows* — and #2 and #5 follow from it directly. #3 is independent but is the
case that shows what a good refusal buys: a refusal that names the field is
what stopped a consumer shipping a silent no-op. #4 is the meta-question: a
gate that cannot tell necessary validation from a regression will keep
obstructing the very checks the other four decisions add.
