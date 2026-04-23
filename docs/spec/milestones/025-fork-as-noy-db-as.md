# Milestone 25 — Fork · As (@noy-db/as-*)

- **State:** open
- **Open issues:** 0
- **Closed issues:** 0
- **Due:** _(none)_
- **Created:** 2026-04-21
- **URL:** https://github.com/vLannaAi/noy-db/milestone/25

---

Parallel, always-open milestone for @noy-db/as-* portable-artefact packages. Fourth main pillar alongside to-* (storage), in-* (integrations), on-* (log-on/auth). Reads as "export as xlsx", "export as noydb", etc.

Two authorization tiers (RFC #249):

• Plaintext tier — as-xlsx, as-csv, as-json, as-xml, as-sql, as-ndjson, as-pdf. Crosses the plaintext boundary. Gated by canExportPlaintext (default OFF for every role; owner grants explicitly).

• Encrypted tier — as-noydb. Wraps the .noydb container format. Zero-knowledge preserved (ciphertext in, ciphertext out). Gated by canExportBundle (default ON for owner/admin, OFF for operator/viewer/client). The asymmetric default reflects asymmetric risk: a bundle is inert without the KEK, so owner backups don't need friction; non-admin exports to external parties do, because bundles outlive keyring revocation.

Both tiers emit an audit-ledger entry with type: "as-export" and an encrypted: true|false discriminator — metadata only, never contents or content hashes.

Shared primitives already shipped: exportJSON(), exportStream(), writeNoydbBundle(), readNoydbBundle(), saveBundle(), loadBundle(). Non-core packages blocked by #249 for the enforcement surface.

See docs/patterns/as-exports.md.
