# Core

> The minimalist always-on core. Six areas. ~6,500 LOC. The floor every NOYDB consumer pays.

The core is what NOYDB **is**, not what it **does**. A consumer using only the core gets a fully working zero-knowledge encrypted document store. Everything else is a [subsystem](../subsystems/) you opt into.

## Pages

| Page | What it covers |
|---|---|
| [01 — Vault & Collections](./01-vault-and-collections.md) | The three-layer data model (`Noydb` → `Vault` → `Collection<T>`), lifecycle, public surface, reserved collection names |
| [02 — Encryption](./02-encryption.md) | AES-256-GCM, PBKDF2-SHA256, KEK / DEK hierarchy, envelope format, critical invariants |
| [03 — Stores](./03-stores.md) | The 6-method `NoydbStore` interface, capabilities, authoring a custom store |
| [04 — Permissions & Keyring](./04-permissions-and-keyring.md) | Roles, single-owner keyring, permission check on every op |
| [05 — Schema & Refs](./05-schema-and-refs.md) | Standard Schema validation, foreign-key refs, ref-mode dispatch |
| [06 — Query Basics](./06-query-basics.md) | Chainable builder (where / orderBy / limit), `scan()` streaming, operator set |

## Related

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — the 17-entry catalog of opt-in capabilities
- [docs/recipes/](../recipes/) — 4 starter recipes that compose core + subsystems
- [docs/reference/](../reference/) — architecture, threat model, store conformance (TODO)
- [SPEC.md](../../SPEC.md) — formal specification (reorg per #285)
