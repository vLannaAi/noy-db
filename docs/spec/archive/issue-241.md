# Issue #241 — docs(schema): schema validator at collection.put() exists — document it prominently + audit every entry point

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.2 — First adoption patch (pilot #1 feedback)
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

Reported by pilot #1 (2026-04-23): *"Today Collection is generic-typed only; wrong-shape data silently persists. Niwat solves this with Zod at the call-site."*

## The reality

The feature **does exist**. `vault.collection<T>(name, { schema: myZodSchema })` runs `validateSchemaInput` before encryption on every `put()`. See `packages/hub/src/collection.ts` — line 147 declares the option, line 657 invokes the validator. Standard Schema v1 compatible (Zod, Valibot, ArkType, Effect Schema).

The gap is not the feature — it is **discoverability**. Pilot hit call-site Zod because they could not find the hook.

## Scope of this issue

1. **Docs**: surface the `schema:` option prominently in
   - `README.md` quick-start section (extend the `defineNoydbStore` example to pass `schema`)
   - `docs/START_HERE.md` feature inventory (tier up from "Schema validation" one-liner to a proper example)
   - `docs/getting-started.md` (main integration walkthrough — currently does not mention)
   - A new `docs/patterns/schema-validation.md` sibling to the email-archive pattern doc

2. **Audit**: confirm the schema hook fires at every entry point that accepts record data:
   - `vault.collection().put()` — confirmed hits validator ✓
   - `vault.collection().putMany()` — pending (depends on bulk ops #feat-bulk)
   - `@noy-db/in-pinia` `defineNoydbStore({ schema })` → `add()` / `update()` — confirmed via showcase #01 canary
   - Import / backup restore paths — `vault.load(bundle)` — AUDIT: does it validate? Probably should opt-in.
   - Dictionary entry `.put()` on `DictionaryHandle` — pilot may hit this too; consider adding schema option to DictionaryOptions.

3. **API ergonomics**: the pilot suggested `defineCollection({ validator })`. That is a syntactic wrapper; the underlying option is already `schema:`. Consider whether to rename (BC break) or add `validator:` as an alias (ambiguous). Recommend: keep `schema:` as the canonical name, document it everywhere.

No feature work needed. Docs-and-audit ticket.
