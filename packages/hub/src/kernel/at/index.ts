/**
 * @noy-db/hub/at — the at-* sealing family door.
 *
 * A sealing-key provider (`at-env`, `at-aws-kms`, `at-gcp-kms`, …) binds
 * ONLY to this subpath: the `SealingKeyProvider` contract concrete
 * providers implement to seal/unseal a hub-generated random passphrase
 * for managed-passphrase mode. Its two methods (`seal`/`unseal`) close
 * over only `Uint8Array`/`Promise`/`string` — no additional option or
 * result types to re-export.
 *
 * NOTE: `SealingKeyProvider` is implemented in `with-party/team/*` (the
 * managed-passphrase service), not the kernel spine proper — same
 * precedent as `@noy-db/hub/ui` re-exporting from `with-shape/introspection`.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type { SealingKeyProvider } from '../../with-party/team/managed-passphrase.js'
