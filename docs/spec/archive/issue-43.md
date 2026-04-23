# Issue #43 — Hash-chained audit log (ledger)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.4.0
- **Labels:** type: feature, type: security, release: v0.4, area: core

---

Part of #41 (v0.4 epic).

## Scope

Replace the current full-snapshot history with a **hash-chained audit log** stored in the compartment's \`_ledger/\` internal collection. Every mutation (put/delete/rotate/grant/revoke) appends an entry \`{ prevHash, op, collection, id, version, ts, actor, payloadHash }\` where \`prevHash\` = sha256 of the previous entry. Tampering with any entry breaks the chain at that point.

## Why

The v0.2 history is a list of full snapshots — great for time-travel, useless for tamper detection. A hash chain makes any modification detectable without an external trusted party. Combined with optional anchoring (user's problem, not ours) it's the foundation of \"verifiable audit\".

## Technical design

- New internal collection \`_ledger\` (prefix-hidden from \`loadAll\`, same as \`_keyring\` and \`_sync\`).
- Entry shape: \`{ _v, _ts, prevHash: string, op: 'put'|'delete'|'rotate'|'grant'|'revoke', collection: string, id: string, version: number, actor: string, payloadHash: string }\`.
- \`payloadHash\` is sha256 of the ciphertext payload, NOT the plaintext — preserves zero-knowledge in the ledger.
- \`prevHash\` is sha256 of the canonical JSON encoding of the previous entry.
- New API:
  - \`compartment.ledger()\` — returns a handle with \`head()\`, \`entries({ from?, to? })\`, \`verify()\`, \`proveEntry(index)\`.
  - \`compartment.verifyLedger()\` — walks the chain, returns \`{ ok: true }\` or \`{ ok: false, divergedAt: index }\`.
  - Merkle proof structure is optional (nice-to-have, not blocking) — can ship in a follow-up.
- Entries themselves are **encrypted** with a separate ledger DEK so adapters still see only ciphertext.
- Sync engine treats ledger entries like any other collection (they flow through the usual push/pull).

## Acceptance criteria

- [ ] \`_ledger/\` collection hidden from \`loadAll\` / normal \`list()\`
- [ ] Every mutation appends exactly one ledger entry
- [ ] \`verifyLedger()\` returns \`{ ok: true }\` on a clean compartment
- [ ] Tampering with an entry (by modifying the encrypted blob) causes \`verifyLedger()\` to return \`{ ok: false, divergedAt: n }\` pointing at the exact broken entry
- [ ] Unit tests covering: clean verify, tampered-mid-chain verify, tampered-last-entry verify, empty ledger, sync engine round-trip
- [ ] No plaintext ever leaks into ledger entries
- [ ] \`ledger.head()\` exposes the current chain head (hex string) so users can anchor it externally
- [ ] CHANGELOG entry

## Estimate

L

## Dependencies

- Soft dep on #(schema-validation sub-issue) — the validator error path should also produce a rejected-write ledger entry (optional, can skip if it complicates the design)

## Out of scope

- Blockchain anchoring (user code)
- Merkle proofs for individual entries (nice-to-have, not blocking v0.4)
- Ledger-based time-travel UI (v0.7 devtools)
