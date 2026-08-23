# ADR 0005 — No `/ui` port; egress is gated, rendering is not

**Status: ACCEPTED, 2026-08-23.** Supersedes nothing. Closes noy-db #1181 and #1182.

Two questions arrived together and turned out to have one answer. Recording them
in a tracked doc rather than in issue comments, because `CLAUDE.md` is
git-ignored family-wide and issue threads do not survive a fresh clone.

---

## Decision 1 — there is no `/ui` port, and the reason is structural

`to`, `at`, `by`, `on` and `as` are **driven** ports: hub holds the reference and
calls the satellite. `StoreLocator` exists because hub instantiates stores; the
sealer is invoked by the enclave; the mesh is driven by schema-update.

**A UI is a driving adapter — it calls hub. Hub never invokes a UI.**

So a `SurfaceLocator` / `SurfaceFactory` would be registry machinery with no
caller. Nobody in any repo would hold a `NoydbSurface` and invoke it
polymorphically.

> A port whose interface nothing consumes is not a contract; it is
> documentation wearing a contract's clothes.

Mirroring the five families would be a **false symmetry**: they plug *into* hub,
`ui-*` sits *on top of* it.

### The falsifiable test this generalises to

For any proposed port, ask: **can the logic move behind a hub call?**

- `as-*` — yes. Hub owns `export`/`import`; a format is `encode`/`decode`. That
  inversion shipped (ADR 0004).
- `ui-*` — no. A component tree cannot move behind a hub call, and hub has no
  reason to hold one.

### Two supporting measurements

- **The contract already exists, extracted rather than invented.**
  `./introspection` carries what real consumers bind, and noy-db-ui migrated
  onto it in #1021.
- **Three implementors are one implementation.** `ui-nuxt` and `ui-suai` both
  wrap a shared core. Every conformance kit written for the port work was wrong
  until its *second independent* binding; a port drawn against one shape would
  call the first genuinely different binding — Excel-web, whose model is nothing
  like a component tree — a failure.

### What would reopen it

1. **A caller.** Code holding `NoydbSurface` references and invoking them
   polymorphically. That makes it a driven port and the objection dissolves.
2. **A demonstrated gap.** A binding whose needs `./introspection` cannot
   express: **write-back negotiation** is the likeliest, and is where to look
   first. The read side is solved and shipped.
3. ~~A runtime gate.~~ **RESOLVED by Decision 2 below — reuse the existing
   gate.** This tripwire is retired, and is recorded as retired so the port
   question is not re-litigated on the theory that a `ui` capability tier would
   have given `/ui` substance. It resolved the other way.

In cases 1 and 2 the port is **extracted from two working consumers**, then a
conformance kit, then the seam — the ordering `port/at/index.ts` already
teaches: *the seam follows the port rather than preceding it.*

---

## Decision 2 — the axis is local-vs-egress, not UI-vs-not-UI

### The claim that prompted it was false

The port-architecture design said hub holds the UI **contract**, and that *"the
contract is also the security gate — data crossing it becomes plaintext for a
UI."*

**A TypeScript interface enforces nothing.** A third-party UI can import the
root barrel and read plaintext without implementing any contract. Shipping a
"security gate" that is a `.d.ts` is worse than shipping none, because it
*reads* as enforcement — the presence-vs-invocation proxy this repo keeps
catching.

The real gate is runtime: `assertCanExport(tier, format)`, conformance-tested by
`@noy-db/test-format-conformance`, which proves an `as-*` entry point refuses
when the gate denies **and refuses before reading a record**.

> ⚠️ **Corrected 2026-08-24: that kit currently covers FIVE of the nine formats,
> not all of them.** The four inverted by ADR 0004 — `as-csv`, `as-sql`,
> `as-xml`, `as-json` — lost their fixtures in #1192/#1193 and cannot be
> re-pointed at the kit as it stands: it denies by proxying the vault, and the
> inverted entry point is a *method* on the vault, so `this` resolves to the real
> object and the denial is bypassed. Tracked as #1209.
>
> The reasoning below is unaffected — it turns on the gate being **runtime rather
> than a type**, which is still true. But "conformance-tested" is currently a
> claim about five formats, and the sentence above said nine.

### There is no `ui` capability tier

The defaults are lose-lose, and that is decisive rather than merely awkward:

| default | consequence |
|---|---|
| **closed** | every existing UI breaks on upgrade |
| **open** | a capability nobody must grant gates nothing — decoration |

### The distinction that does work

**Local rendering is not egress.** `ui-vue` / `ui-nuxt` drawing to a screen for
the user who already unlocked the vault is covered by unlock + ACL. The `as-*`
gate exists because bytes *persist* somewhere the vault does not control.

**Pushing plaintext into a third-party service is egress**, whatever renders it.
Google Sheets, Excel-web, Airtable and Retool persist and index what they
receive. That is the population the `as-*` gate exists for — and `as-aws-s3` was
already reclassified as a destination for exactly this reason.

> **A UI that exports is an export.** It calls
> `assertCanExport('plaintext', <its format id>)` — the gate that already
> exists, inheriting the conformance kit, with no new tier and no parallel
> security surface.

This makes the *existing* invariant total rather than adding a new one:
**plaintext persisted outside the vault's control passes `assertCanExport`** now
covers files, S3 and SaaS bindings in one enforced sentence.

### ⚠️ Honest scope — this is a convention plus a conformance row, not a boundary

`as-*` refuses because **hub's own export paths call the gate**. A third-party
binding on the root barrel can simply not call it. Stating that plainly is the
whole point: writing it as an enforcement boundary would recreate the
".d.ts as security gate" claim one level up.

The enforceable half is the conformance row — *an egress binding refuses before
reading a record when the capability is absent* — and passing it is the
condition for carrying the family label. The same social-plus-conformance
contract `to-*` runs on.

### Prerequisite, shipped

#1196 made `ExportFormat` an **open** union (`… | (string & {})`). Before it, a
third-party format id could be *checked* by the gate — a runtime
`Array.includes` — but never *granted*, because the union was closed. The only
way to authorise one was the `'*'` wildcard, which grants every format at once.
Decision 2 was literally unimplementable by anyone outside this repo until that
landed.
