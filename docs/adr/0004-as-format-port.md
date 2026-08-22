# ADR 0004 — `as-*` becomes a port: hub owns the export verbs

**Status: ACCEPTED** 2026-08-22. Supersedes the working position shipped in
#1177/#1178, which treated `as-*` as a library family with a conformance-tested
obligation.

## Context

The family design doc reversed to "`as-*` becomes a port" on three
measurements, and that reversal was then **re-derived away** — #1177 argued
from *"hub never calls a format"* as though it were a constraint rather than a
description of the current shape, and shipped a conformance kit instead. This
ADR restores the reversal and records the measurements so the polarity does not
flip a third time.

### What was measured

```
as-* public API              41 exported functions across 10 packages
download()                   11 lines, duplicated 8×, differing in an
                             extension and a MIME type
ExportFormat                 a CLOSED union: 9 formats + '*' — a new format
                             needs a hub release just to be NAMEABLE
the export gate              called per-package by convention, i.e. ten
                             independent chances to ship an ungated plaintext
                             door with nothing that would catch it
cross-repo reach             28 code files + 35 docs across noy-db-docs,
                             noy-db-ui, klum-db
```

### Why inversion beats the obligation kit it replaces

`@noy-db/test-format-conformance` (#1177) checks that every entry point calls
`assertCanExport` **before reading a record**. It is mutation-checked and it
found two real vacuities. It also has a ceiling that no amount of test quality
raises:

> **A kit catches implementors who run it. Hub owning the gate catches
> everyone — including third-party formats this family will never see.**

Inversion makes the property structural rather than checked: a format never
holds a `Vault`, so "gated before decrypting" stops being a duty and becomes an
impossibility.

The falsifiable test that licenses it, and that separates this from the `/ui`
decision (ADR-adjacent, see #1181): **can the plaintext-touching logic move
behind a hub call?** For `as-*` the answer is yes — `encode(rows)` is pure. For
`ui-*` it is no — hub cannot own a render loop — which is why `ui-*` keeps the
driving-port shape on `/introspection` and does **not** get this treatment.

## Decision

`as-*` is **export AND import** — data, schema, validation. The port is
symmetric, and the import half turns out to be the more damaged of the two.

### MEASURED — the import side is worse than the export side

```
ImportPolicy = 'merge' | 'replace' | 'insert-only'
    declared SIX times across as-* packages, byte-identical
    and hub DOES NOT CONTAIN IT AT ALL

As<X>ImportPlan { plan: VaultDiff; policy: ImportPolicy; apply(): Promise<void> }
    declared per package, byte-identical in every copy checked

VaultDiff        hub-owned, on the root barrel
ImportPolicy     nowhere in hub
ImportPlan       nowhere in hub
assertCanImport  on no subpath
```

So an import plan today is **half hub-owned and half copy-pasted**: `VaultDiff`
comes from hub, the policy and the plan wrapper are six independent
declarations that nothing compares. That is the `on-shamir` structural-mirror
defect — a satellite redeclaring a hub-shaped type with no compile-time link —
except six times over, and without even a hub-side original to drift *from*.

The import gate is duplicated the same way the export gate is:
`assertCanImport` is called per package, by convention.

### The port

Hub publishes `@noy-db/hub/as` carrying the symmetric contract, and owns the
verbs on both sides:

```ts
interface NoydbFormat<Out extends string | Uint8Array> {
  readonly id: string
  readonly extension: string
  readonly mimeType: string
  encode(chunks): Out | Promise<Out>          // rows in, bytes out — pure
  decode(input: Out): DecodedRecords          // bytes in, rows out  — pure
}

vault.export(asCsv(), opts)          // hub gates, reads, redacts, downloads/writes
vault.import(asCsv(), input, opts)   // hub gates, plans, validates → ImportPlan
```

`ImportPolicy` and `ImportPlan` become hub types on `/as`. `ExportFormat`'s
closed union stops gating what is nameable: a format declares its own `id`.

**Schema and validation land on hub's side of the line, where the primitives
already are** — `jsonSchemaToFields` and `StandardSchemaV1Issue` are already
published on `/introspection`, while the formats infer locally today
(`as-csv:193 inferColumns`). A format decodes bytes to records; deciding
whether those records fit the collection's schema is hub's job, once, rather
than four packages' jobs, four ways.

Of the five in scope, four have an import path (`as-sql` is export-only). That
is a property of the implementations, not of the contract.

## ⚠️ `write()` cannot move into hub — `hub-portable` forbids it

The Context section says hub absorbs `download`/`write`. Measured against the
architecture guard, only part of that is available:

`check-architecture`'s `hub-portable` rule forbids Node builtins anywhere in
`hub/src`, because hub must run in a browser, Worker, Deno and Bun. Every
`as-*` `write()` does `await import('node:fs/promises')`. The guard's patterns
match `from '…'` and would NOT catch a dynamic `import(…)` — which makes this a
loophole, not permission. Taking it would put a call into hub that throws in
three of the four runtimes hub claims to support.

**So the split is:**

| moves to hub | stays in the package |
|---|---|
| the export **gate** | `download()` — 3 lines of platform code |
| the vault **read** | `write()` — 3 lines, plus the Node import |
| **redaction** | |
| `encode` orchestration | |

The 11-line duplicated body collapses to ~3 lines that are genuinely
platform-specific. The gate, the read and the redaction — everything with a
correctness or security consequence — move once. That is the substance; the
remaining lines are the part that legitimately differs per runtime.

`acknowledgeRisks` stays a hub-owned assertion so the plaintext-to-disk gate
is not re-implemented five times either.

## ⚠️ Scope — this reaches FIVE of ten packages, not ten

The design doc's sketch assumes every `as-*` is `rows → bytes`. Measured
against what each actually reads from the vault, that is true of five:

| package | reads | fits `encode(rows)` |
|---|---|---|
| `as-csv` `as-json` `as-ndjson` `as-sql` `as-xml` | `vault.exportStream` | **yes** |
| `as-xlsx` | `vault.collection`, multi-sheet composition | no — composes N collections |
| `as-zip` | `vault.collection` + attachments + password | no — records AND blobs |
| `as-blob` | one record's blob slot | no — not rows at all |
| `as-noydb` | `coreWrite` (pod) | no — **`bundle` tier**, encrypted output |
| `as-aws-s3` | nothing; `assertCanExport` never called | **not a format** — a destination |

This is the third family this year that looked uniform and was not, after
`on-*` and `as-*`'s own two-tier gate. Forcing all ten through one interface
would repeat the mistake this ADR exists to correct.

**So the port covers the five row-stream formats.** The other five keep their
current API and their conformance-kit obligation, which is exactly what a kit
is for: the cases where inversion is unavailable.

`as-aws-s3` is reclassified as a destination and leaves the format family.

## Consequences

- **Breaking for five packages.** `toString`/`download`/`write` collapse into a
  factory returning a `NoydbFormat`. Accepted explicitly by the owner on the
  measured cost above, pre-1.0.
- **Hub gains one opt-in service**, not kernel surface — `withFormats()`, with a
  throwing NO-OP stub, so a vault that never exports ships none of it. "Lean
  hub" is preserved by opt-in, not by refusing the service.
- **`test-format-conformance` narrows** to the five packages that keep the
  obligation, and gets a home on `/as` for the two-tier gate types.
- The five inverted packages need no gate test at all — there is no gate left
  to skip.

## The falsifier was checked FIRST, and it strengthened the design

The risk was that `encode(chunks)` could not be expressed without leaking a
`Vault` back into the format. Measured: **all five call
`vault.collection(x).describe()`, and all five do it for exactly one purpose —
redaction**, which they then apply with hub's own `applyListProjection`.

That is not a leak, it is a **second duplicated concern the inversion
subsumes**. Hub already holds the description and already reads the rows, so it
can apply redaction before `encode` ever sees a record:

```ts
encode(chunks: ReadonlyArray<{ collection, records }>): Out
//                                     ^ already redacted, already projected
```

Consequences:

- a format needs **no vault access at all** — the interface can be pure
- redaction policy is enforced **once, in hub**, instead of five times
- which is the same move as the gate: a duty becomes an impossibility

So the inversion subsumes `download`, `write`, **and** redaction. It is worth
more than this ADR's Context section claims, and the check that would have
falsified it is the reason we know.

## What would still falsify it

A format needing per-record vault access *during* encoding — a lookup, a blob
fetch, a join. None of the five does. `as-zip` and `as-blob` do, which is a
second, independent reason they stay out of scope.
