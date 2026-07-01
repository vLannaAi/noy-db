# `@noy-db/hub/pod` — the vault-serialization artifact seam

In the architecture lexicon a **pod** is a vault **serialized + saved** — the
`.noydb` binary container (10-byte magic prefix + JSON header + compressed
body). `/pod` is the **canonical** artifact seam:

- `writePod` / `readPod` / `readPodHeader` — the primary ops (pod-named
  canonical aliases over the underlying bundle implementations).
- the `.noydb` format constants + header helpers (`NOYDB_BUNDLE_MAGIC`,
  `NOYDB_BUNDLE_FORMAT_VERSION`, `FLAG_*`, `COMPRESSION_*`,
  `validateBundleHeader`, `encodeBundleHeader`) — kept under their existing
  names.
- the pod/backup error classes (`BundleIntegrityError`,
  `BundleSealMismatchError`, `BundleVersionConflictError`, `BackupLedgerError`,
  `BackupCorruptedError`) — kept under their existing names so `instanceof`
  keeps working across subpath boundaries.

`/pod` **supersedes** `@noy-db/hub/bundle`, which remains as a **deprecated
alias** for existing pins and will not be removed without a coordinated version
bump. New consumers should bind `/pod`.

**Not here:** partition / interchange ops (extract, adopt, transfer re-keyed
slices between vaults). Managing pods & slices is *cargo*'s job — see
`@noy-db/hub/cargo`.

The export surface is frozen by `__tests__/pod-surface-golden.test.ts` against
`pod-surface.golden.json` (additive-only). See
`docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md`.
