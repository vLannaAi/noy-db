# Issue #46 — Verifiable backups

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, type: security, release: v0.4, area: core

---

Part of #41 (v0.4 epic).

## Scope

Make \`compartment.dump()\` include the current ledger head, and make \`compartment.load(backup)\` refuse a backup whose ledger doesn't verify or whose head doesn't match the embedded value. Signed-by-KEK metadata guarantees the backup wasn't tampered with between dump and restore.

## Why

Today a backup is \"whatever the adapter saw at dump time.\" An attacker who modifies the backup blob can silently corrupt a restored compartment. v0.4's ledger gives us the primitives to detect this — we just need to wire it into \`dump\`/\`load\`.

## Technical design

- \`dump()\` result gains a top-level \`ledgerHead\` field: \`{ hash: string, index: number, ts: string, signature: string }\`.
- \`signature\` is the ledger head hash, HMAC-SHA256'd with a key derived from the current KEK. (The KEK itself never persists, but a deterministic derivative that the same KEK can reproduce is fine.)
- \`load(backup)\`:
  1. Parse \`ledgerHead\`; reject if missing.
  2. Verify the HMAC signature with the loading user's KEK. Reject on mismatch (means the backup was signed by a different user or was modified).
  3. Load the ciphertext into a temp compartment.
  4. Call \`verifyLedger()\` on the loaded state. Reject if it doesn't verify.
  5. Reject if the computed head doesn't match \`ledgerHead.hash\`.
  6. Commit.
- Backwards compat: old backups without \`ledgerHead\` load with a console warning. After v0.5 we drop this path.

## Acceptance criteria

- [ ] \`dump()\` embeds \`ledgerHead\` with HMAC signature
- [ ] \`load()\` verifies the HMAC; rejects on mismatch with \`BackupSignatureError\`
- [ ] \`load()\` runs \`verifyLedger()\` on the decoded snapshot; rejects on chain divergence with \`BackupLedgerError\`
- [ ] \`load()\` rejects if the computed head diverges from the embedded head
- [ ] Tampering test: modify 1 byte of an encrypted record in a backup → load throws
- [ ] Tampering test: modify \`ledgerHead.hash\` → load throws
- [ ] Round-trip test: \`load(dump())\` works for a non-trivial compartment
- [ ] Backwards-compat: old-format backup loads with a warning
- [ ] CHANGELOG entry

## Estimate

M

## Dependencies

- Blocked by: hash-chained ledger sub-issue
