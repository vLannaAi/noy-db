# Issue #42 — Schema validation via Standard Schema v1

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, release: v0.4, area: core

---

Part of #41 (v0.4 epic).

## Scope

Wire Standard Schema v1 (https://standardschema.dev) into \`@noy-db/core\` so any validator that implements the spec — Zod, Valibot, ArkType, Effect Schema — can be attached to a collection. Validation runs **before encryption on \`put()\`** and **after decryption on \`get()\`/\`list()\`/\`query()\`**. Type inference flows from the validator's output type through \`Collection<T>\` and \`defineNoydbStore<T>\`.

## Why

Today a bad record silently persists and explodes later at the UI layer. With schema validation, \`invoices.put({...garbage})\` fails at the store boundary with a rich error, and the TS types are inferred from a single source of truth. The accounting platform needs this to catch manually-entered data mistakes.

## Technical design

- New \`schema?: StandardSchemaV1<Input, Output>\` option on \`Collection\` and \`defineNoydbStore\`.
- On \`put()\`: call \`schema['~standard'].validate(value)\`. If the result has \`issues\`, throw \`ValidationError\` with the issue list. If successful, use the \`value\` from the result (which may be a coerced/transformed version).
- On \`get()\`/\`list()\`/\`query()\` results: same validation applied after decrypt. Misvalidation here is a **hard error** — it means stored data diverged from the current schema, which should be loud. (Future: a \`migrate\` hook that can upgrade legacy records.)
- Type parameter \`T\` is inferred from \`StandardSchemaV1.InferOutput<Schema>\` when a schema is supplied.
- Standard Schema is a TYPES-ONLY protocol. No runtime dep. Validators are peer-optional — users install their own.
- Add examples to \`docs/guides/end-user-features.md\` using Zod and Valibot side-by-side.

## Acceptance criteria

- [ ] New \`ValidationError\` class in core
- [ ] \`Collection.put\` validates input; rejects invalid records with the Standard Schema issue list
- [ ] \`Collection.get\`/\`list\`/\`query\` validate output; hard-error on divergence
- [ ] \`defineNoydbStore<T>\` accepts a schema and infers \`T\` automatically (no explicit generic needed)
- [ ] Unit tests with Zod (as the canonical validator) — at least 10 cases covering success, failure, type inference, the transform case, and the re-read divergence case
- [ ] Integration test: a store with a schema rejects a bad \`add()\` without corrupting the store
- [ ] Playground example updated to use Zod
- [ ] No runtime dep on any validator in \`@noy-db/core\`
- [ ] CHANGELOG entry

## Estimate

M

## Dependencies

- None (first v0.4 sub-issue)
