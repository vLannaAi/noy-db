# Issue #249 — RFC(as-*): two-tier authorization model — canExportPlaintext + canExportBundle

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

## RFC — authorization model for `as-*` portable-artefact packages

**Context.** The `as-*` family (`as-xlsx`, `as-csv`, `as-xml`, `as-json`, `as-ndjson`, `as-sql`, `as-noydb`, …) extracts vault data as discrete artefacts the consumer subsequently holds. Unlike `plaintextTranslator` or schema validators — which a consumer enables unilaterally in their own code — every `as-*` invocation needs a hub-enforced gate because the output artefact persists outside the vault's runtime control.

This issue is the RFC for that gate. It blocks every `as-*` package: #107 `as-sql`, #246 `as-xlsx`, #247 `as-csv`, #248 `as-xml`, #250 `as-json`, #251 `as-ndjson`, the planned `as-noydb`.

**Policy design (documented).** See `docs/patterns/as-exports.md` and SPEC.md §"What zero-knowledge does and does not promise". The model has **two authorization tiers** distinguished by whether the artefact crosses the plaintext boundary, plus three shared mechanisms.

### The two tiers

| Tier | Packages | Capability bit | Default | Reason for default |
|------|----------|----------------|---------|--------------------|
| **Plaintext** | `as-xlsx`, `as-csv`, `as-json`, `as-xml`, `as-sql`, `as-ndjson`, `as-pdf` (+ core `exportJSON()`/`exportStream()`) | `canExportPlaintext` | **off for every role** | Artefact is world-readable by anyone who finds it. Owner must positively grant. |
| **Encrypted** | `as-noydb` (+ core `writeNoydbBundle()`/`saveBundle()`) | `canExportBundle` | **on for owner/admin, off for operator/viewer/client** | Artefact is inert without the KEK. Owner backups don't need friction; non-admin exports to external parties do, because bundles outlive keyring revocation. |

### The three shared mechanisms

1. **Keyring read permission** — existing ACL. Already enforced by `exportStream()`; will be enforced by the bundle path too.
2. **Capability bit check** — new, this RFC. Tier-specific (see above).
3. **Optional just-in-time re-auth** — existing `SessionPolicy.requireReAuthFor: 'export'`. Applies to both tiers equally; no new session machinery.

### Composition matrix

| Tier | Read ACL | Cap bit | Re-auth fresh? | Result |
|------|:-:|:-:|:-:|--------|
| Plaintext | ✗ | — | — | `NoAccessError` (existing) |
| Plaintext | ✓ | ✗ | — | `AuthorizationError` (new) |
| Plaintext | ✓ | ✓ | ✗ (required) | `SessionPolicyError` — prompt, retry |
| Plaintext | ✓ | ✓ | ✓ / not required | Export proceeds |
| Encrypted | ✗ | — | — | `NoAccessError` |
| Encrypted | ✓ | ✗ | — | `AuthorizationError` |
| Encrypted | ✓ | ✓ | ✗ (required) | `SessionPolicyError` — prompt, retry |
| Encrypted | ✓ | ✓ | ✓ / not required | Export proceeds |

### Open questions for the RFC

#### Q1 — shape of each capability
Per-format allowlist (`canExportPlaintext: ['xlsx', 'csv']`), blanket boolean (`canExportPlaintext: true`), or per-collection-×-per-format matrix?

**Suggested default for v1**: boolean for `canExportBundle` (bundles are whole-vault — per-format makes no sense); per-format allowlist for `canExportPlaintext` (so `operator` can export `xlsx` for clients but not `sql` dumps of the whole schema).

#### Q2 — grant/revoke API surface
Folded into existing `grant()`/`revoke()` with an export-capability payload, or new dedicated methods (`grantExport()` / `revokeExport()`)? Latter is more discoverable; former keeps the permission surface small.

#### Q3 — persistence
Capability bits persist in the keyring file (alongside permissions) so revocation survives vault restart. The keyring schema needs a new field. Bump `_noydb_keyring_version` for back-compat detection.

#### Q4 — enforcement points
- Plaintext tier: single point in `vault.exportStream()`. Every plaintext `as-*` package builds on this.
- Encrypted tier: single point in a new `vault.writeBundle()` — the gated wrapper around `writeNoydbBundle()`. `@noy-db/as-noydb` calls this; the un-gated `writeNoydbBundle()` in hub remains for legitimate internal use (e.g., the `.noydb` snapshot in `routeStore` ephemeral routing). **This is an intentional asymmetry with the plaintext tier, which builds on the existing ungated `exportStream()` plus the gate in the caller path.** The encrypted path needs a new wrapper because `writeNoydbBundle()` is reachable from multiple hub internals that do not need the gate — we can't bolt the check onto the primitive without breaking them. So the RFC does obligate a new `Vault` method. Smaller-scope alternative rejected: "let `@noy-db/as-noydb` do its own gate check before calling `writeNoydbBundle()`" — a malicious fork could skip the check; routing through `vault.writeBundle()` means there is nowhere else to route.

Formatters that reach into `collection.list()` directly bypass the check — **code review rejects that pattern on sight**.

#### Q5 — interaction with `requireReAuthFor: 'export'`
Re-auth fires on top of both capability checks, not instead of either. Same `'export'` operation name covers both tiers — if the owner wants to distinguish (e.g., require re-auth for plaintext but not for bundle), that's a v2 concern. For v1, `'export'` is the single hook.

#### Q6 — audit-ledger entry shape
Single `type: 'as-export'` with an `encrypted: boolean` discriminator:

```ts
type AsExportLedgerEntry = {
  type: 'as-export',
  encrypted: boolean,
  package: string,          // e.g. '@noy-db/as-xlsx' or '@noy-db/as-noydb'
  collection: string | null,  // null for whole-vault (as-noydb)
  recordCount: number,
  actor: string,              // keyring id
  mechanism: string,          // 'xlsx' | 'csv' | 'noydb-bundle' | …
  grantedBy: string | null,   // who flipped the bit on; null if default-on
  reauthFresh: boolean | null,  // null if re-auth wasn't required
  // encrypted-tier only:
  bundleHandle?: string,      // ULID from readNoydbBundleHeader
  bundleBytes?: number,
  timestamp: string,
}
```

**No contents, no content hashes, no field values — either tier.** The encrypted-tier-only fields (`bundleHandle`, `bundleBytes`) come from the `.noydb` format's unencrypted header, so no new info leaks.

### Acceptance criteria for closing this RFC

- [ ] Q1–Q5 resolved in follow-up comment thread
- [ ] Type shapes added to `packages/hub/src/types.ts`: `ExportCapability` (two fields), updated `Keyring` type, new `AsExportLedgerEntry` variant
- [ ] Plaintext enforcement path in `vault.exportStream()`
- [ ] Encrypted enforcement path in a new `vault.writeBundle()` wrapper
- [ ] Grant/revoke API (shape TBD from Q2) in the team subpath
- [ ] Keyring schema bump for persistence
- [ ] Audit-ledger entry type extended; both tiers emit it
- [ ] `exportJSON()` / `exportStream()` honour `canExportPlaintext`
- [ ] `writeNoydbBundle()` remains un-gated for internal use; the gated path is the new `vault.writeBundle()`
- [ ] Test: plaintext `as-*` without grant → `AuthorizationError`
- [ ] Test: plaintext `as-*` with grant + stale session → `SessionPolicyError`
- [ ] Test: `as-noydb` as `owner` → succeeds without explicit grant (default-on)
- [ ] Test: `as-noydb` as `operator` without grant → `AuthorizationError`
- [ ] Test: `as-noydb` as `operator` with grant → succeeds
- [ ] Test: ledger entry emitted + metadata-only + correct `encrypted` discriminator
- [ ] Pattern doc `docs/patterns/as-exports.md` updated from "TBD — see #249" to the resolved shape

### Scope boundaries

- This RFC does NOT design any specific `as-*` package; those live in their own issues.
- This RFC does NOT extend the 6-method `NoydbStore` contract — exports are a vault-level concern.
- This RFC does NOT change `plaintextTranslator` or schema-validator semantics — those remain consumer-only opt-in.
- This RFC does NOT forbid `writeNoydbBundle()` being called without a gate inside hub internals — the gate wraps `writeNoydbBundle()`, it doesn't replace it.
