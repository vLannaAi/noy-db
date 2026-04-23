# Issue #83 — feat(core): plaintextTranslator hook — consumer-supplied translation integration point

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.8.0
- **Labels:** type: feature, type: security, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#78. Part of the v0.8 i18n epic. Builds on `i18nText` (#82) — a translator without something to translate is meaningless.

**This issue includes the security-critical naming + invariant decisions.** The implementation is small; the surface that needs care is the API contract, the spec invariant, and the audit ledger format.

## Problem

A common request for `i18nText` fields is "auto-translate missing languages before `put()`." The obvious implementation — having noy-db call an external translation API — **violates the zero-knowledge invariant** the moment plaintext leaves the library over a TLS connection to OpenAI / DeepL / Google / Claude / Argos / etc. It doesn't matter that the adapter never sees plaintext: the text just left the zero-knowledge boundary through a different door.

The wrong answer is "don't support it" — that leaves consumers reinventing the same pre-put wrapper badly, with no audit trail and no per-field opt-in. The right answer is **the library ships the integration point, the consumer ships the integration**.

## Proposed solution

A `plaintextTranslator` config option on `createNoydb()`, plus a per-field `autoTranslate: true` opt-in on `i18nText` schemas.

```ts
const db = await createNoydb({
  adapter: ...,
  user: 'alice',
  secret: '...',
  plaintextTranslator: async ({ text, from, to, field, collection }) => {
    // Consumer's choice: DeepL, Argos, Claude with their data policy,
    // self-hosted LLM, human review queue, literally anything.
    // noy-db does not know or care.
    return await myTranslator.translate(text, from, to)
  },
})

const LineItem = z.object({
  description: i18nText({
    languages: ['en', 'th'],
    required: 'all',
    autoTranslate: true,            // ← per-field opt-in, visible in schema source
  }),
})

// Now this works even though only English is provided:
await lineItems.put('li-1', {
  id: 'li-1',
  description: { en: 'Consulting hours' },   // 'th' auto-translated via the hook
})
```

## Naming — `plaintextTranslator`, not `translator`

**The hook is named `plaintextTranslator` deliberately.** The same naming logic as `@noy-db/decrypt-*` packages applies: routine names produce routine accidents, and a config key with the word "plaintext" in it forces the consumer to acknowledge the boundary they're crossing every time they read or write the config. It shows up in:

- `createNoydb()` call sites (visible in code review)
- TypeScript autocomplete (the consumer types `plaintext...` and sees the warning in the JSDoc)
- The schema field with `autoTranslate: true` (visible in the schema source)
- Every test mock for the translator hook

If the discomfort of typing `plaintextTranslator` feels excessive, that's exactly the point — consumers who feel weird typing it are consumers who pause before doing the thing that needs pausing.

## Spec invariant — already merged in `NOYDB_SPEC.md`

The invariant clarification this hook builds on is already merged in [`NOYDB_SPEC.md` § Zero-Knowledge Storage](https://github.com/vLannaAi/noy-db/blob/main/NOYDB_SPEC.md#2-zero-knowledge-storage). Key points enforced by this issue:

- The library **ships no built-in translator** and **ships no translator SDKs as dependencies**. PRs adding either are rejected.
- Per-field opt-in at schema-construction time, never at runtime. There is no runtime path that can opt a field in without an explicit schema declaration.
- The set of fields opted into the hook is determined entirely at schema-construction time and visible in the schema source.

## Audit ledger format — `contentHash` is deliberately NOT included

Each translator invocation writes one ledger entry recording **only**:

```json
{
  "type": "translator-invocation",
  "field": "description",
  "collection": "lineItems",
  "fromLocale": "en",
  "toLocale": "th",
  "translatorName": "consumer-supplied-string",
  "timestamp": "2026-04-07T..."
}
```

**The ledger entry deliberately does NOT include a content hash.** A content hash would be a fingerprint that allows correlation of identical phrases across the audit trail. If a consumer translates the same phrase multiple times (English error messages, common product names, recurring line items), identical hashes would let a future attacker who gains read access to the ledger but not the records learn the structure of the consumer's translated content — which phrases recur, how often, in which fields. Combined with frequency analysis and any external knowledge of the domain, this is a real fingerprinting surface.

The audit story is "field X was sent to translator Y at time T" — that's enough for any compliance requirement and to reproduce the call site. The hash adds nothing the consumer can verify (they don't have the original plaintext to hash against later) and creates a leak they did not consent to.

The `translatorName` field is a consumer-provided string — noy-db does not enforce, validate, or canonicalize it. A consumer can pass `'deepl-pro-with-dpa'` or `'self-hosted-llama-7b'` or just `'manual-review-queue'`.

## Translator cache lifecycle

- **In-process only.** Content-hash cache (in-memory) so repeated puts of the same text don't re-hit the translator.
- **Plaintext keys.** The cache holds plaintext both as keys and values — fine because plaintext is in memory anyway during a put.
- **Cleared on `db.close()`.** The cache is destroyed alongside the KEK and DEKs. This is enforced and tested — a long-running process that holds plaintext fragments in cache after the user has logged out is the exact session-lifetime leak that v0.7 (Identity & sessions) is designed to prevent.
- **Never persisted, never serialized, never shared across `Noydb` instances.**

## Translator invocation contract

- **Async only.** Sync translators are rejected at type level.
- **Per-field**, not batched. Batching would require the library to construct a "what fields need translation" plan that crosses record boundaries, which complicates the put path for marginal gains.
- **One ledger entry per invocation**, even if the cache hits — cache hits write a ledger entry with a `cached: true` flag so the audit trail still records that the field was processed by the translator hook.
- **Consumer-supplied error handling.** If the translator throws, the put throws — the library does not silently fall back. The consumer's translator can implement its own retry/fallback logic.

## What this issue does NOT add

- **A `@noy-db/translator-deepl` package** — separate userland follow-up, peer dep on `deepl-node`, with the same warning-block-everywhere policy as `@noy-db/decrypt-*`
- **A `@noy-db/translator-argos` package** — separate follow-up, self-hosted Argos Translate
- **A `@noy-db/translator-claude` package** — separate follow-up, peer dep on `@anthropic-ai/sdk`
- **Any auto-detection of source language** — the consumer's translator function gets `from` explicitly; if `from` is unknown, that's the consumer's translator's problem
- **Translation memory persistence** — the in-process cache is enough for v1; persistent translation memory is a future opt-in, not a v1 deliverable

## Acceptance

- [ ] `plaintextTranslator?: (ctx) => Promise<string>` config option on `createNoydb()`
- [ ] `autoTranslate: true` opt-in on `i18nText({ ... })` schema type, requires `plaintextTranslator` to be configured (throws `TranslatorNotConfiguredError` otherwise)
- [ ] In-process content-hash cache, cleared on `db.close()`
- [ ] One ledger entry per invocation with the documented format (no `contentHash`, ever)
- [ ] `cached: true` flag on cache-hit ledger entries
- [ ] Translator errors propagate as `put()` errors, no silent fallback
- [ ] Sync translator functions rejected at type level
- [ ] Tests covering: per-field opt-in, missing translator config, translator throws → put throws, cache hit/miss behavior, ledger entry format (asserts `contentHash` is absent), cache cleared on close, no `contentHash` field anywhere in the codebase
- [ ] **Spec invariant text** (already merged in `NOYDB_SPEC.md` § Zero-Knowledge Storage) referenced in the JSDoc
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext — translator invocation happens in core, the adapter never sees the call
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped — translator cache cleared on `db.close()` alongside the KEK
- [x] **Zero new external dependencies in `@noy-db/core`** — no translator SDKs bundled, ever
- [x] Plaintext-exit point is documented in the spec invariant clarification (already merged) and is per-field opt-in only

v0.8.0 milestone. Depends on #82 (`i18nText`). The security-critical decisions (naming, no-content-hash, cache lifecycle) are part of the issue contract — review carefully.
