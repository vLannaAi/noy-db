/**
 * `@noy-db/hub/at` — the sealing-key port (the `at-*` family port).
 *
 * A sealing-key provider — `at-env`, `at-aws-kms`, `at-gcp-kms`,
 * `at-macos-keychain`, `at-azure-keyvault`, or a third party's — binds ONLY
 * this subpath: the {@link NoydbSealer} contract plus the in-memory double an
 * implementor develops against. Mirrors `@noy-db/hub/to` for stores.
 *
 * ## Why this seam exists NOW and did not before
 *
 * `/at` shipped in 0.3.0 and was removed in 0.4.0 — "family port removed, it
 * had zero importers" — along with `/as`, `/in`, `/on` and `/ui`. Only `/to`
 * survived, and the difference is not taste: `/to` had a contract, a registry
 * and a conformance kit behind it, so a store author had a reason to bind it.
 * `/at` was a second place to find a type already on the root barrel.
 *
 * What changed is not the subpath, it is what stands behind it:
 * `@noy-db/test-sealer-conformance` publishes the contract as an executable
 * suite, so "implements NoydbSealer" now means one checkable thing. The seam
 * follows the port rather than preceding it — which is the ordering 0.4
 * demonstrated the hard way.
 *
 * ⚠️ Re-introducing a retired subpath is declared, not incidental: the
 * `unretired` list in `codemods/0.7.0-pre.json` records it, and
 * `codemod-map.test.ts` refuses to accept the claim unless the subpath really
 * resolves. Consumers who followed the 0.4 codemod row onto the root barrel
 * are untouched — this is additive, and the root barrel and `/cargo` keep
 * exporting everything they did.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit
 * and tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type { NoydbSealer } from '../../with-party/team/managed-secret.js'
export { MemorySealer, MemoryRecipientSealer } from '../../with-party/team/managed-secret.js'
export type { RecipientSealer } from '../../kernel/types.js'
export type { SealedSecret, SealedEnvelope, RecipientHint } from '../../with-party/team/managed-secret.js'
export { parseSealedEnvelope, SEALED_SECRET_RECORD_ID } from '../../with-party/team/managed-secret.js'
