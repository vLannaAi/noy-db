# @noy-db/core

## 0.5.0

### Initial release

Zero-knowledge, offline-first, encrypted document store — the core library with AES-256-GCM encryption, PBKDF2 key derivation, a multi-user keyring system, a hash-chained audit ledger, and a reactive query DSL.

**Crypto and access control.** All cryptography uses the Web Crypto API (`crypto.subtle`) — zero runtime dependencies. AES-256-GCM with a fresh 12-byte random IV per encrypt. PBKDF2-SHA256 with 600,000 iterations for key derivation. AES-KW (RFC 3394) for wrapping DEKs with the per-user KEK. The KEK never persists — it exists only in memory during an active session. Five roles: `owner`, `admin`, `operator`, `viewer`, `client`. Admins can grant and revoke any other admin with a subset-check guardrail (`PrivilegeEscalationError`) and automatic cascade-on-revoke through the delegation tree (`RevokeOptions.cascade`, default `'strict'`).

**Compartments and collections.** A `Noydb` instance holds the auth context and adapter references. Each `Compartment` is a tenant namespace with its own keyrings and collections. Each `Collection<T>` has its own DEK, an optional Standard Schema v1 validator (Zod, Valibot, ArkType, Effect Schema), optional foreign-key references via `ref()` with strict / warn / cascade modes, and either eager or lazy LRU-bounded hydration.

**Hash-chained audit ledger.** Every `put` and `delete` appends an encrypted entry to the compartment's `_ledger` internal collection. Entries link via `prevHash = sha256(canonicalJson(previousEntry))`, so any tampering breaks the chain. `payloadHash` is computed over the **encrypted** envelope, preserving zero-knowledge. `Compartment.ledger()` exposes `head()`, `entries({ from, to })`, `verify()`, and `reconstruct()` for rebuilding any historical version via reverse RFC 6902 JSON Patches stored in `_ledger_deltas`.

**Verifiable backups.** `Compartment.dump()` produces a tamper-evident encrypted JSON envelope that embeds the current ledger head plus the full `_ledger` and `_ledger_deltas` internal collections. `Compartment.load()` verifies the chain end-to-end on restore. `Compartment.verifyBackupIntegrity()` cross-checks data envelopes against the ledger's recorded `payloadHash`es — catches chain tampering, ciphertext substitution, and out-of-band writes.

**Authorization-aware plaintext export.** `Compartment.exportStream()` is an `AsyncIterableIterator<ExportChunk>` that yields per-collection (or per-record with `granularity: 'record'`) chunks of decrypted records, with schema and ref metadata attached. ACL-scoped: collections the caller cannot read are silently skipped. `Compartment.exportJSON()` is a five-line wrapper returning a `Promise<string>` with a stable on-disk shape. Both carry an explicit plaintext-on-disk warning block in JSDoc.

**Cross-compartment role-scoped queries.** `Noydb.listAccessibleCompartments({ minRole? })` enumerates every compartment the calling principal can unwrap at the requested minimum role. The existence-leak guarantee means compartments the caller has no keyring for (or wrong passphrase for) are silently dropped — never confirmed in the return value. `Noydb.queryAcross(ids, fn, { concurrency? })` fans a callback out across the supplied list with per-compartment error capture and opt-in concurrency. Composes with `exportStream()` for cross-tenant plaintext export in a single call.

**Reactive query DSL.** `collection.query()` returns a chainable `Query<T>` builder with operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus a `.filter(fn)` escape hatch and `.and()`/`.or()` composition. Terminal methods: `.toArray()`, `.first()`, `.count()`, `.subscribe()`, `.toPlan()`. Plans are JSON-serializable for devtools and Web Worker offloading. Secondary indexes via `indexes: ['status', 'clientId']` turn equality and `in` clauses into O(1) hash lookups — built client-side after decryption, never touching the adapter.

**Streaming and lazy hydration.** `Collection.scan()` is an `AsyncIterableIterator<T>` for memory-bounded iteration over very large collections. `cache: { maxRecords, maxBytes }` collection option enables lazy mode: `get(id)` hits the adapter on miss and populates an LRU. Peak memory stays bounded regardless of collection size.

**Adapter contract.** Six mandatory methods (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`), plus optional capabilities: `listPage` for pagination, `listCompartments` for cross-compartment enumeration, `ping` for connectivity checks. Adapters never see plaintext — encryption happens in core before data reaches any adapter.

**Sync engine.** Optional dirty tracking, push/pull with optimistic concurrency via `expectedVersion`, pluggable conflict strategies (`local-wins`, `remote-wins`, `version`, or a user-supplied callback), and autoSync on `online`/`offline` events.

**Biometric and session management.** WebAuthn-backed biometric unlock for browser contexts, session timeout that clears keys from memory after inactivity, passphrase strength validation via Zxcvbn-style entropy estimation.

Zero runtime dependencies.
