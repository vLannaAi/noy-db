# Sealing provider id (`pid`) stability

The `pid` (provider id) of an `at-*` sealing key provider is the **dispatch key** for every sealed envelope on disk. When hub reads `_meta/sealed-passphrase`, it picks the right provider to unseal by comparing the envelope's `pid` to the registered provider's `.id`. Once a provider ships, every envelope in the wild references its `pid` format — changing it would orphan those envelopes.

This document captures the one rule that governs `pid` across the `at-*` family.

## The rule

> **Each `at-*` provider owns its `pid` format. Once a provider ships v1.x, the `pid` format is semver-frozen — changing it is a major-version break of that provider package, treated with the same discipline as a public API break.**

Concretely, every `at-*` package MUST:

1. Define its `pid` format in the README under "Provider id format."
2. Ship a pid-stability test file (e.g., `__tests__/pid-stability.test.ts`) that locks the format with golden-string assertions.
3. Document any future format change as a major-version bump with a migration story.

## Current formats

| Package | `pid` format | Example | Test location |
|---|---|---|---|
| `@noy-db/at-env` | `env:{envVar}` | `env:NOYDB_SEALING_KEY` | `packages/at-env/__tests__/pid-stability.test.ts` |
| `@noy-db/at-macos-keychain` | `macos-keychain:{service}/{account}` | `macos-keychain:com.acme.app/alice@acme.example` | `packages/at-macos-keychain/__tests__/at-macos-keychain.test.ts` |

When future `at-*` packages ship (`at-wincred`, `at-libsecret`, `at-aws-kms`, `at-gcp-kms`, `at-azure-keyvault`, `at-webauthn-prf`), add their formats here.

## Why this matters

A sealed envelope persisted at `_meta/sealed-passphrase` looks like:

```json
{
  "v": 1,
  "_noydb_sealed": 1,
  "pid": "env:NOYDB_SEALING_KEY",
  "payload": "<base64 sealed bytes>"
}
```

The `pid` field is the only thing the consumer's app has to route the unseal call to the right provider. If `@noy-db/at-env` v1 emits `env:NOYDB_SEALING_KEY` and v2 emits `at-env:NOYDB_SEALING_KEY`, every existing vault sealed under v1 is unreadable by v2.

This is a stronger discipline than typical npm packages because the artifact (the sealed envelope) lives on disk indefinitely — often longer than the package's release cadence. A `pid` change is more like a database schema migration than a code-level API tweak.

## Analogue: `to-*` adapter resource triples

The `to-*` storage adapter family follows the same discipline for its `{ resource, kind, id }` triple: once shipped, the format is frozen. Changing it would orphan every record on disk written under the old shape. The reasoning is identical for `pid`.

## If you ever genuinely need to change `pid` format

The escape hatch is **multi-provider sealing** (per §11.7 Op C of the at-* foundation doc):

1. New provider version emits BOTH old-`pid` and new-`pid` envelopes (`_meta/sealed-passphrase` becomes an array of `SealedEnvelope`).
2. Deprecate the old `pid` over a release window.
3. Old envelopes get migrated lazily: any vault that opens under the new version writes a new-`pid` envelope on first close, dropping the old.
4. After the deprecation window, drop the old-`pid` emission entirely.

This is genuinely expensive (the array form bumps envelope schema version) and should be reserved for actual format problems, not cosmetic preference. Most "I want to change the pid" requests should be resolved by NOT changing it — the format is opaque metadata, not user-facing copy.

## Related

- [`docs/superpowers/specs/2026-05-23-sealing-at-dimension-foundation.md`](./../superpowers/specs/2026-05-23-sealing-at-dimension-foundation.md) — full architectural context (§11.9.1 names this rule)
- [`packages/hub/src/team/managed-passphrase.ts`](../../packages/hub/src/team/managed-passphrase.ts) — `SealedEnvelope` type definition + the dispatch path that uses `pid`
