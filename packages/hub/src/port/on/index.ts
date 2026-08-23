/**
 * `@noy-db/hub/on` — the unlock port (the `on-*` family port).
 *
 * ## What this seam is, and what it deliberately is NOT
 *
 * The `on-*` family is **not uniform**, and this subpath does not pretend
 * otherwise. Measured across ten packages (see `check-architecture.mjs`'s
 * `on-family-classification`):
 *
 *   - **one port instance** — `on-shamir` supplies a {@link NoydbShamir} that
 *     hub calls for `profile: 'shamir'` recovery.
 *   - **two slot ceremonies** — `on-password` and `on-webauthn` implement
 *     {@link SlotRewrapCeremony}, which hub calls back during `rotateSecret`
 *     to preserve a tier-2 slot.
 *   - **seven libraries** — `on-totp`, `on-threat`, `on-email-otp` and the
 *     rest. Three import hub zero times, which is the correct amount of
 *     coupling for a TOTP code generator, not a gap to close.
 *
 * So the honest sentence, and the one the docs should carry: **`on-*`
 * packages that hold or rotate a keyring slot implement contracts from here;
 * the rest are freestanding utilities.** A seam is a namespace, not a claim
 * that every package in the family binds it — `/to` already carries two
 * instance types, and nobody reads that as one contract.
 *
 * ## Why it exists NOW and did not before
 *
 * `/on` shipped in 0.3.0 and was pruned in 0.4.0 for "zero importers",
 * alongside `/as`, `/at`, `/in` and `/ui`. It was a second place to find types
 * already on the root barrel.
 *
 * What changed is what stands behind it. `@noy-db/test-ceremony-conformance`
 * publishes the ceremony contract as an executable suite, and the symbols it
 * needs are scattered: three live on `/team`, and `KeyringAuthenticator`,
 * `EnclaveKey` and `NoydbShamir` are reachable only from the whole root
 * barrel. A third-party unlock method has to import the entire library to name
 * the five types its ceremony signature uses — which is the coupling this
 * family's seams exist to remove, and the same argument that brought `/at`
 * back.
 *
 * ⚠️ Re-introducing a retired subpath is declared, not incidental: the
 * `unretired` list in `codemods/0.7.0-pre.json` records it, and
 * `codemod-map.test.ts` refuses the claim unless the subpath really resolves.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit.
 */
export type { NoydbShamir } from '../../with-party/team/noydb-shamir.js'
export type {
  SlotRewrapCeremony,
  SlotRewrapContext,
  EnrollAuthenticatorOptions,
} from '../../with-party/team/index.js'
export type { KeyringAuthenticator } from '../../kernel/types.js'
export type { UnlockedKeyring } from '../../with-party/team/keyring.js'
export type { EnclaveKey } from '../../kernel/enclave/index.js'
