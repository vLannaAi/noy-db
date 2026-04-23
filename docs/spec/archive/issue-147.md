# Issue #147 — rename: Compartment → Vault across the public API

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** enhancement

---

## Motivation

`Compartment` is the correct internal term — it encodes *tenant namespace* and *encryption boundary* simultaneously. But it requires explanation every time a new developer encounters the API:

```ts
const comp = await noydb.openCompartment('acme')  // what is a compartment?
const invoices = comp.collection('invoices')
```

**`Vault` requires no explanation.** Every developer immediately understands:
- isolation (a vault is self-contained)
- encryption (a vault is locked until opened)
- active read/write (HashiCorp Vault, AWS Key Vault, 1Password — all active, not archival)

The resulting API reads naturally without a glossary:

```ts
const vault = await noydb.openVault('acme')
const invoices = vault.collection('invoices')
```

`openVault()` is also semantically accurate: you are literally unlocking an encrypted namespace with a passphrase (PBKDF2 → KEK → unwrap DEKs). The verb *open* paired with *vault* maps directly to what the cryptography does.

## Scope

**Public API changes (breaking):**

| Old | New |
|---|---|
| `class Compartment` | `class Vault` |
| `CompartmentBackup` | `VaultBackup` |
| `CompartmentSnapshot` | `VaultSnapshot` |
| `noydb.openCompartment(name)` | `noydb.openVault(name)` |
| `noydb.listCompartments()` | `noydb.listVaults()` |
| `NoydbAdapter.listCompartments?()` | `NoydbAdapter.listVaults?()` |
| adapter param `compartment: string` | `vault: string` (cosmetic — positional) |

**Not breaking:**
- Stored data — the vault name is a user-supplied string (`'acme'`). The word `compartment` never appears in the envelope format, backup JSON keys, or adapter storage paths. **No data migration needed.**
- Internal event payloads — runtime only, not persisted.

**Blast radius:** ~727 occurrences across 77 files. Entirely mechanical; a single search-replace pass handles the bulk of it, with targeted cleanup for compound names (`CompartmentBackup`, `listCompartments`, `cross-compartment`).

## Timing

Pre-1.0 (`v0.10`) is the right moment. Semver's external-consumer contract starts at 1.0.0; doing this now costs zero downstream breakage and avoids carrying an awkward term into the stable API surface.

## Open question

Keep `collection` as-is or rename to something else in the same pass? `vault.collection('invoices')` already reads well — `collection` is the established NoSQL term (MongoDB, Firestore, Realm). Recommend keeping it unchanged.
