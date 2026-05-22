# Schema dump — human-readable vault audit (CLI + persisted JSON Schema)

> Adds a CLI command `noydb describe` that emits a human-readable YAML/JSON description of a `.noydb` bundle's structure (collections, fields, indexes, FKs, MVs, overlays, derivations, guards, history, blobs, i18n, ACLs, subsystem matrix), with optional counters (records, bytes total/avg/min/max, oldest/newest). To make field-level intent visible from a bundle alone, opt-in **persisted JSON Schema** snapshots are written to a new `_schemas/<collection>` envelope at `collection()` registration. Targets the pre.16 release.

## Goal

Give an auditor — typically the firm's accounting/IT lead handed a `.noydb` file — a single command that produces a self-contained, readable description of what's inside, without needing to run the application code that produced the file:

```bash
$ noydb describe ./acme-vault.noydb --with-stats -o vault.shape.yaml
```

The output is the answer to "what's in this thing?" — every collection's purpose and shape, plus how big they are. Output is single-file YAML or JSON, with stats inlined when requested.

Three vertical landings:

1. **Hub: persisted JSON Schema (Route B).** Opt-in `collection({ persistJsonSchema: true })` derives a JSON Schema from Zod validators at registration time and writes it to a `_schemas/<collection>` envelope. Hash-based skip avoids write churn on every open.
2. **Hub: introspection primitive.** `compartment.dumpSchema({ withStats })` walks every registered subsystem and returns a structured `VaultSchemaSnapshot` object. Used by the CLI; available programmatically for app-side audit pages.
3. **CLI: `noydb describe` command.** Loads a bundle, resolves the passphrase (env → flag → prompt), calls the introspection primitive, emits YAML/JSON.

## Success criteria (acceptance)

### Hub: Route B persisted JSON Schema

- `collection({ schema: zodSchema, persistJsonSchema: true })` accepted at registration with no behaviour change to record-level validation (Zod still runs on `put`/read).
- For Zod validators, hub derives a JSON Schema via `zod-to-json-schema` (optional peer-dep) and writes `_schemas/<collection>` with `{ kind: 'Zod', jsonSchema, hash, derivedAt, _noydb_schema: 1 }` — **AES-GCM encrypted with the collection's DEK** (same encryption envelope as the collection's records; the schema body is sensitive metadata, not public).
- For non-Zod Standard Schema validators (Valibot, ArkType, Effect Schema), hub writes a stub envelope `{ kind: 'Valibot' | 'ArkType' | 'Effect', jsonSchema: null, reason: 'derivation not yet supported in v0', _noydb_schema: 1 }`, also encrypted with the collection's DEK for consistency.
- On every `collection()` registration with `persistJsonSchema: true`: derive → canonicalise → SHA-256 hash → compare to stored envelope's `hash`. If equal, skip write. If different (or no envelope), write fresh.
- `vault.exportJSON()`'s currently-always-null `schema` field is populated from `_schemas/<collection>` when the envelope exists. Existing tests against `schema: null` remain valid for vaults that have NOT opted in.
- `compartment.dump()` chunk stream emits the persisted JSON Schema (when present) in a new `chunk.persistedSchema` field. Independent of the existing `chunk.schema` (live validator object).
- `zod-to-json-schema` is declared as an **optional peer-dep**; absent at install time → calling `persistJsonSchema: true` with a Zod validator throws `PersistedSchemaError` at registration with a clear "install zod-to-json-schema" message.
- Hub bundle size grows by ≤ 2 KB (the derivation glue + envelope plumbing only; converter library is peer-dep).

### Hub: introspection primitive

- `compartment.dumpSchema(opts?: { withStats?: boolean; sampleSize?: number }): Promise<VaultSchemaSnapshot>` exposed from `@noy-db/hub`.
- Snapshot includes: vault name, subsystem opt-in matrix, ACL roles, public envelope (if present), every collection with fields/indexes/FK refs/guards/history-strategy/blob-fields/i18n-labels, every MV (sources, groupBy, aggregate, refresh mode), every overlay view, every derivation.
- Field source per collection: (1) persisted JSON Schema decrypted from `_schemas/<collection>` (`source: 'persisted'`) — **requires passphrase** since the envelope is now AES-GCM encrypted with the collection's DEK; (2) live validator introspected via Standard Schema's `~standard` protocol (`source: 'live-validator'`) when the call site is in-process and a validator is attached; (3) sampled from up to `sampleSize` decrypted records (`source: 'sampled'`) when neither is available; (4) empty with `source: 'unknown'` when no passphrase is provided (both persisted-schema decryption AND sampling become unavailable).
- With `withStats: true`: each collection/MV/overlay block carries `stats: { records, bytes, bytesAvg, bytesMin, bytesMax, oldest, newest }`. `oldest`/`newest` derive from the unencrypted `_ts` envelope field (**no decrypt required** — stats work without passphrase). `bytes` totals come from envelope `_data` lengths (also no decrypt). `bytesAvg/Min/Max` are computed in the same envelope walk. **Stats are the only thing that works zero-auth.**
- Field order within a collection preserves the validator's declaration order (Zod source order). Top-level snapshot keys (collections list, MVs list, overlays) are alphabetical for diff stability.
- Internal collections (`_keyring`, `_ledger`, `_meta`, `_schemas`, `_deltas`, ...) are excluded from the user-visible `collections` section but counted in a separate `internal:` block when `withStats: true`.
- Walking a 100-collection / 1 M-record vault runs in under 5 seconds end-to-end (in-memory backend) with `withStats: true`.

### CLI: `noydb describe`

- New subcommand: `noydb describe <bundle-path> [--with-stats] [--format yaml|json] [-o <file>] [--passphrase <p>] [--sample <n>]`.
- Bundle path is required; missing file exits 2 with usage.
- Format default: `yaml`. JSON output is `JSON.stringify(snapshot, null, 2)`. YAML output uses the `yaml` npm package as a CLI-scoped peer-dep (hub stays zero-dep; `yaml` is only required by `@noy-db/cli`).
- Both formats emit a structured top-level `_provenance` field (no YAML-only comment header): `{ generatedBy: 'noydb describe v0.1.0', source: '<bundle-path>', sourceSha256: '<hex>', emittedAt: '<ISO-8601>' }`. Single source of truth across yaml/json. Numbers are emitted as plain integers (JSON-compatible) — no underscore separators.
- Output destination: stdout by default; `-o <file>` writes file.
- Passphrase resolution: `--passphrase` flag OR `NOYDB_PASSPHRASE` env. **No interactive prompt.** Absence of both = no decryption attempted (sampling silently skipped; collections without persisted schema show `source: unknown`). `--passphrase` use logs a one-time stderr warning about shell history.
- Auth failure (wrong passphrase) → exit 3 with `decryption failed: check passphrase` to stderr.
- Sampling is **smart-auto**: when passphrase is available (flag or env), sample up to 50 records per collection that lacks a persisted/live schema. When no passphrase, sampling is silently skipped and those collections show `source: 'unknown'`. Override sample size via `--sample <n>` (still requires passphrase); `--sample 0` forces skip even when passphrase is present.
- Exit codes: 0 ok; 1 internal error; 2 usage error; 3 auth failure.
- `noydb --help` lists the new `schema dump` subcommand.

### Cross-cutting

- Hub tests pass (current 1601 baseline + new tests for Route B + introspection).
- CLI tests pass (new tests for `schema dump` against fixture bundles).
- One showcase under `showcases/` exercises a vault with persisted JSON Schema enabled, opens the bundle, runs the CLI, asserts the emitted YAML round-trips through `JSON.parse(JSON.stringify(yaml-parsed))` to the expected shape.
- `features.yaml` gains entries `persisted-json-schema` and `cli-schema-dump`.
- `docs/subsystems/` gains `schema-dump.md` (CLI usage + Route B opt-in).
- `docs/core/05-schema-and-refs.md` cross-links to Route B opt-in and clarifies the runtime-vs-persisted distinction.
- `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm turbo test` all green.

## Scope — what's in

| Feature | In | Notes |
|---|:---:|---|
| `CollectionOptions.persistJsonSchema: boolean` | ✓ | Default `false`. Backward-compatible. |
| `_schemas/<collection>` envelope (plaintext, AES-GCM-bypassed) | ✓ | Mirrors `_meta/handle` / `_meta/public-envelope` / `_keyring` storage pattern |
| Zod → JSON Schema derivation via `zod-to-json-schema` peer-dep | ✓ | Optional peer-dep; absent → clear error at registration |
| Stub envelope for non-Zod validators | ✓ | `{ kind, jsonSchema: null, reason }` so the slot exists for follow-up |
| Hash-based skip on registration | ✓ | SHA-256 of canonicalised JSON Schema; written only on mismatch |
| `compartment.dumpSchema({ withStats })` | ✓ | Public hub API; returns typed snapshot |
| Field source provenance (`persisted` / `live-validator` / `sampled` / `unknown`) | ✓ | Each field carries a `source:` marker in the emitted snapshot |
| Counter walk via envelope metadata only (no decrypt for bytes/`_ts`) | ✓ | Byte totals + oldest/newest computable without passphrase |
| Sampling fallback for fields when no schema is available | ✓ | Default `--sample 50`; configurable; `--sample 0` opts out |
| Single combined YAML/JSON output | ✓ | `stats:` inline per collection when `--with-stats` |
| Field order = validator declaration order; top-level keys alphabetical | ✓ | Reads like the Zod source; top-level still diff-stable |
| `--schemas <full\|sidecar\|none>` flag for JSON Schema body inclusion | ✓ | Default `none` (summary only); `full` inlines; `sidecar` writes `<out>.schemas/<col>.schema.json` |
| Internal-collection stats under separate `internal:` block | ✓ | Visible only with `--with-stats`; user-facing collections list omits internals |
| CLI passphrase resolution: flag → env → prompt | ✓ | One-time stderr warning when `--passphrase` used |
| `vault.exportJSON()` `schema` slot populated from persisted envelope | ✓ | Backfill the forward-compat slot that's currently always null |
| `yaml` peer-dep in `@noy-db/cli` only (hub stays zero-dep) | ✓ | Battle-tested emitter; scoped to the package that needs it |

## Scope — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| JSON Schema derivation for Valibot / ArkType / Effect Schema | v0.2 follow-up | Each needs its own converter; v0 ships Zod (the 80% case) with stub envelopes flagging the rest |
| Round-trip schema → vault scaffolding (`noydb schema apply`) | post-v1 | This is `prisma migrate` territory; out of scope for an audit tool |
| Schema diff (`noydb schema diff <live> <file>`) | v0.3 | Useful but additive on top of the v0 emitter |
| TypeScript codegen from emitted schema (`noydb schema codegen`) | post-v1 | Codegen needs the validator surface to round-trip; not in v0 |
| Visual / diagram emit (Mermaid, dbml, drawio) | separate milestone | Tracked separately; depends on this milestone landing first |
| Multi-vault dump (one CLI call, multiple bundles) | follow-up | v0 is one bundle in / one snapshot out |
| Streaming output for huge vaults | premature | Memory-first design caps individual vaults at 1K–50K records per collection; in-memory snapshot is fine |
| Per-keyring / per-tier stats breakdown | v0.2 follow-up | Distribution stats (avg/min/max) ship in v0; finer slicing waits for real audit demand |
| Schema versioning + migration of `_schemas/<collection>` between hub versions | with `@noy-db/hub/migrations` reserved subsystem | Premature at v0; envelope carries `_noydb_schema: 1` so a v2 can migrate cleanly |
| Encrypted JSON Schemas (for vaults where field names themselves are sensitive) | future opt-in | Default is plaintext (auditor convenience); encrypted variant is a v0.3+ option behind a flag |
| Live in-process introspection without opening a bundle | partial today | `compartment.dumpSchema()` works in-process; v0 just doesn't add a CLI mode for it |

## Non-goals

- Replacing Standard Schema validators with a native noy-db DSL. Zod stays the recommended validator; Route B just snapshots its derived shape for portability.
- Making persisted schemas authoritative for validation. They're a portability record; record validation still runs through the live validator on `put`/read. Drift between persisted and live is **not** a runtime error.
- Auto-persisting schemas without opt-in. `persistJsonSchema: true` is required per collection; default behaviour is unchanged.
- Recovering field-level data from a corrupt bundle. Out of scope; `noydb verify` handles integrity, not recovery.
- Hiding the existence of internal collections. `_keyring` / `_ledger` / `_schemas` etc. show up under `internal:` with `--with-stats`. The intent is audit visibility, not secrecy.

## Type surface

### Hub additions (`@noy-db/hub`)

```ts
// packages/hub/src/types.ts
export interface CollectionOptions<T> {
  schema?: StandardSchemaV1<unknown, T>
  refs?: Record<string, Ref>
  // ...existing fields...

  /**
   * When true and `schema` is a Zod schema, derive a JSON Schema at
   * registration and persist it to `_schemas/<collection>`. Enables
   * `noydb describe` to surface field-level intent from a bundle
   * without needing the app code that registered the collection.
   *
   * Default: false. No behavioural change to record-level validation
   * either way — Zod still runs on put/read.
   *
   * Requires `zod-to-json-schema` peer-dep when used with a Zod schema.
   * Non-Zod Standard Schema validators write a stub envelope flagging
   * the kind without a JSON Schema body.
   */
  persistJsonSchema?: boolean
}

// packages/hub/src/meta/persisted-schemas/types.ts
export interface PersistedSchemaEnvelope {
  readonly _noydb_schema: 1
  /** Detected validator family. */
  readonly kind: 'Zod' | 'Valibot' | 'ArkType' | 'Effect' | 'Unknown'
  /**
   * JSON Schema (Draft 2020-12) derived from the validator. Null when
   * derivation isn't yet supported for `kind`, with `reason` populated.
   */
  readonly jsonSchema: object | null
  /** SHA-256 of the canonicalised JSON Schema. Used for hash-based skip. */
  readonly hash: string | null
  /** Human-readable reason when `jsonSchema` is null. */
  readonly reason?: string
  /** ISO-8601 timestamp of the most recent derivation write. */
  readonly derivedAt: string
}

// packages/hub/src/introspection/types.ts
export interface VaultSchemaSnapshot {
  readonly _noydb_snapshot: 1
  readonly vault: string
  readonly emittedAt: string
  readonly subsystems: Record<string, boolean>     // { history: true, guards: true, ... }
  readonly aclRoles: ReadonlyArray<string>          // ['admin', 'client', 'operator', ...]
  readonly publicEnvelope?: PublicEnvelopeSummary
  readonly collections: Record<string, CollectionDescriptor>
  readonly materializedViews: Record<string, MaterializedViewDescriptor>
  readonly overlayViews: Record<string, OverlayViewDescriptor>
  readonly derivations: Record<string, DerivationDescriptor>
  readonly internal?: Record<string, InternalCollectionStats>  // only with withStats
}

export interface CollectionDescriptor {
  readonly description?: string
  readonly fields: Record<string, FieldDescriptor>
  readonly indexes: ReadonlyArray<IndexDescriptor>
  readonly refs: Record<string, RefDescriptor>
  readonly guards: ReadonlyArray<string>            // guard names
  readonly history?: { strategy: string }
  readonly blobFields: ReadonlyArray<string>
  readonly i18nLabels?: Record<string, string>      // { en: 'Invoices', th: '...' }
  readonly aclRoles?: Record<string, ReadonlyArray<'read'|'write'>>
  readonly validator?: {
    readonly kind: PersistedSchemaEnvelope['kind']
    readonly source: 'persisted' | 'live-validator' | 'sampled' | 'unknown'
  }
  readonly stats?: CollectionStats                  // only with withStats
}

export interface FieldDescriptor {
  readonly type: string                             // 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'opaque'
  readonly source: 'persisted' | 'live-validator' | 'sampled' | 'unknown'
  readonly constraints?: Record<string, unknown>    // { minLength, maxLength, enum, pattern, gt, ... }
  readonly optional?: boolean
  readonly references?: string                      // 'clients.id'
}

export interface CollectionStats {
  readonly records: number
  readonly bytes: number
  readonly bytesAvg: number
  readonly bytesMin: number
  readonly bytesMax: number
  readonly oldest: string                           // ISO-8601 from _ts
  readonly newest: string                           // ISO-8601 from _ts
}

// Compartment API
export interface Compartment {
  // ...existing methods...
  dumpSchema(opts?: { withStats?: boolean; sampleSize?: number }): Promise<VaultSchemaSnapshot>
}
```

### CLI additions (`@noy-db/cli`)

```ts
// packages/cli/src/commands/schema.ts
export interface SchemaDumpOptions {
  readonly bundlePath: string
  readonly format: 'yaml' | 'json'
  readonly withStats: boolean
  readonly outPath?: string
  readonly passphrase?: string
  readonly sampleSize: number
}

export async function runSchemaDump(argv: readonly string[]): Promise<number>
```

```
usage: noydb describe <bundle-path> [options]
  --format <yaml|json>     output format (default: yaml)
  --with-stats             include records / bytes / oldest / newest per collection
  --schemas <mode>         JSON Schema body inclusion (default: none)
                           - none:    summary only (terse audit view)
                           - full:    inline complete JSON Schema per collection
                           - sidecar: separate files `<out>.schemas/<col>.schema.json`
  -o, --out <file>         write to file instead of stdout
  --passphrase <p>         passphrase (also: NOYDB_PASSPHRASE env, or prompt)
  --sample <n>             max records to sample for fields fallback (default: 50; 0 = disable)
```

## Storage / envelope format

Persisted JSON Schemas live in a new reserved `_schemas` collection. One record per user-facing collection, keyed by the collection's name. **AES-GCM encrypted with the same DEK as the collection's records** — the schema body is sensitive metadata (field names, enum values, constraints can reveal domain-specific intent), so it gets the same encryption envelope as the data. Unlocking access to the collection's records unlocks access to its schema; nothing more.

| Field | Type | Notes |
|---|---|---|
| `_noydb` | `1` | Envelope format version (existing) |
| `_v` | `number` | Monotonic per-record version (existing) |
| `_ts` | `ISO-8601` | Last write timestamp (existing) |
| `_iv` | `string` | Random 12-byte AES-GCM IV (base64) — standard envelope |
| `_data` | `string` | AES-GCM ciphertext (base64) of JSON-stringified `PersistedSchemaEnvelope` |

The `_schemas` collection name is reserved alongside the existing `_keyring`, `_ledger`, `_meta`, `_deltas` set. Store implementations need no changes — it's just another collection from the store's perspective.

Path inside a bundle:

```
_schemas/
  invoices         (envelope holding the JSON Schema for the `invoices` collection)
  clients          (...)
  payments         (...)
```

## Algorithms

### Route B: derivation + hash-based skip

At `vault.collection(name, opts)` when `opts.persistJsonSchema === true`:

```
1. Detect validator kind from opts.schema via Standard Schema introspection:
   - Zod:    presence of `_def.typeName` (`ZodObject`, `ZodString`, ...)
   - Valibot: presence of `kind === 'schema'` + `type` discriminant
   - ArkType: presence of `.toJsonSchema` method
   - Effect: presence of Schema marker symbol
   - else: kind = 'Unknown'
2. If kind === 'Zod':
   - Lazy-require 'zod-to-json-schema'. Absent → throw PersistedSchemaError.
   - jsonSchema = zodToJsonSchema(opts.schema, { target: 'jsonSchema2020-12' })
   - hash = sha256(canonicalize(jsonSchema))
3. Else: jsonSchema = null, hash = null, reason = `derivation not yet supported for ${kind}`
4. Read existing _schemas/<name> envelope. If exists and stored.hash === hash, skip step 5.
5. Write _schemas/<name> envelope with { _noydb_schema: 1, kind, jsonSchema, hash, derivedAt: now(), reason? }.
```

`canonicalize(obj)` is a deterministic JSON serializer: sort object keys lexicographically, preserve array order. Implemented as a small recursive helper inside `meta/persisted-schemas/`.

The lazy-require for `zod-to-json-schema` keeps hub's required-dep count at zero. The optional peer is declared in `package.json` `peerDependenciesMeta` with `optional: true`.

### Introspection walk

`compartment.dumpSchema(opts)` runs in three phases:

```
Phase 1 — assemble structure (no decrypt needed for skeleton; persisted schemas need DEK)
  - vault name from compartment
  - subsystems opt-in from compartment's registered with*() seams
  - acl roles from policy module
  - publicEnvelope from _meta/public-envelope (plaintext)
  - per user-facing collection:
      - persisted JSON Schema from _schemas/<name> DECRYPTED with collection's DEK
        if present AND the compartment is unlocked; else mark source = 'live-validator'
        if validator in scope, else 'sampled' (deferred to phase 3), else 'unknown'
      - indexes, refs, guards, history-strategy, blobFields, i18nLabels, aclRoles
        from the collection's runtime descriptor (in-memory; no decrypt)
  - per MV: sources, groupBy, aggregate, refresh from withMaterializedView spec
  - per overlay view: source, where-clause, fields from withOverlayView spec
  - per derivation: kind, inputs, outputs from withDerivation spec

Phase 2 — counters (when opts.withStats; no decrypt needed)
  - for each collection: store.list(compartment, collection) → envelopes
    - records = envelopes.length
    - bytes = sum(env._data.length for env in envelopes)
    - bytesAvg / Min / Max = derived from same walk
    - oldest = min(env._ts), newest = max(env._ts)
  - same walk for _keyring, _ledger, _schemas, _meta, _deltas
    → emitted under snapshot.internal

Phase 3 — field sampling fallback (only when no persisted/live schema)
  - for each collection lacking a field source:
    - take up to sampleSize envelopes
    - decrypt (requires passphrase to have unlocked the compartment)
    - merge inferred field types from sampled records
    - mark fields source = 'sampled'
```

Phase 1 + 2 run without decrypting any record bodies. Phase 3 needs a decrypted view, which is already available via the in-memory compartment cache after the bundle is opened.

### Sampling type inference

```
For each sampled record:
  for each (key, value) pair:
    case typeof value:
      'string':  field.type = 'string'; track maxLen, detect format (iso8601, ulid, uuid)
      'number':  field.type = 'number'; track min, max
      'boolean': field.type = 'boolean'
      'object':  field.type = value === null ? 'null' : 'object'
                 if Array.isArray(value): field.type = 'array'

Merge across samples:
  - if any sample has a field absent: mark optional: true
  - if types disagree: collapse to 'opaque' (rare; record is malformed)
  - enum detection: if ≤ 12 unique string values across all samples,
    emit { type: 'enum', values: sorted unique }
```

## CLI surface — full grammar

```
$ noydb describe <bundle-path> [options]

Positional:
  bundle-path                 path to .noydb file (required)

Options:
  --format <yaml|json>        output format (default: yaml)
  --with-stats                include counters per collection / MV / overlay
  -o, --out <file>            write to file instead of stdout
  --passphrase <p>            decryption passphrase (warns about shell history)
                              (also: NOYDB_PASSPHRASE env, or TTY prompt)
  --sample <n>                max records sampled per collection for field
                              inference when no persisted/live schema exists
                              (default: 50; 0 disables sampling)
  -h, --help                  show this help

Exit codes:
   0   ok
   1   internal error (printed to stderr)
   2   usage error (missing args, bad option)
   3   auth failure (wrong passphrase / no passphrase available)
```

Examples:

```bash
# basic structural dump to stdout
noydb describe ./acme.noydb

# with counters, write to file
NOYDB_PASSPHRASE='hunter2' noydb describe ./acme.noydb --with-stats -o vault.shape.yaml

# JSON for tooling
noydb describe ./acme.noydb --format json | jq '.collections | keys'

# CI audit: prompt for passphrase, no sampling fallback
noydb describe ./acme.noydb --with-stats --sample 0 -o ci-audit.yaml
```

## Sample output

```yaml
_noydb_snapshot: 1
_provenance:
  generatedBy: noydb describe v0.1.0
  source: acme-vault.noydb
  sourceSha256: 4a7c...
  emittedAt: 2026-05-22T14:31:42Z
vault: acme-accounting
emittedAt: 2026-05-22T14:31:42Z

subsystems:
  blobs: true
  derivations: true
  guards: true
  history: true
  i18n: true
  materializedViews: true
  overlayViews: true

aclRoles: [admin, client, operator, owner, viewer]

publicEnvelope:
  name: { en: 'Acme Accounting', th: 'แอคเม' }
  description: { en: 'Q2 2026 books' }

collections:
  clients:
    description: External parties the firm invoices.
    validator: { kind: Zod, source: persisted }
    fields:
      country:
        type: string
        source: persisted
        constraints: { pattern: '^[A-Z]{2}$' }
      created_at:
        type: string
        source: persisted
        constraints: { format: 'iso8601' }
      display_name:
        type: string
        source: persisted
        constraints: { minLength: 1, maxLength: 200 }
      id:
        type: string
        source: persisted
      tax_id:
        type: string
        source: persisted
        optional: true
    indexes:
      - fields: [country, display_name]
      - fields: [tax_id]
        unique: true
    refs: {}
    guards: []
    blobFields: []
    i18nLabels: { en: Clients, th: ลูกค้า }
    stats:
      records: 412
      bytes: 138640
      bytesAvg: 336
      bytesMin: 180
      bytesMax: 1204
      oldest: 2024-03-01T08:12:00Z
      newest: 2026-05-20T18:22:11Z

  invoices:
    description: Outbound invoices in dual EUR/THB currencies.
    validator: { kind: Zod, source: persisted }
    fields:
      amount:
        type: number
        source: persisted
        constraints: { gt: 0 }
      client_id:
        type: string
        source: persisted
        references: clients.id
      status:
        type: enum
        source: persisted
        constraints: { values: [draft, open, overdue, paid] }
      # ...
    indexes:
      - fields: [client_id, date]
    refs:
      client_id: { target: clients, mode: strict }
    guards: [recordLock, fieldFreeze]
    history: { strategy: fullAudit }
    blobFields: []
    i18nLabels: { en: Invoices, th: ใบกำกับภาษี }
    stats:
      records: 1247
      bytes: 428612
      bytesAvg: 344
      bytesMin: 200
      bytesMax: 8204
      oldest: 2024-03-01T08:14:32Z
      newest: 2026-05-22T14:31:42Z

materializedViews:
  monthlyByClient:
    sources: [invoices]
    groupBy: [client_id, period]
    aggregate: { total: 'sum(amount)' }
    refresh: eager
    stats:
      records: 84
      bytes: 24192
      bytesAvg: 288

overlayViews:
  paidInvoices:
    source: invoices
    where: 'status == "paid"'

derivations: {}

internal:
  _keyring:   { records: 4, bytes: 8120 }
  _ledger:    { records: 1843, bytes: 412004 }
  _schemas:   { records: 3,  bytes: 14280 }
  _meta:      { records: 2,  bytes: 1104 }
```

## Showcases

One end-to-end showcase under `showcases/` (numbered per the existing convention):

| Showcase | Purpose |
|---|---|
| `schema-dump-with-persisted-validators/` | Build a small vault with three collections, two with `persistJsonSchema: true` (Zod) and one without, save as `.noydb`, run `noydb describe --with-stats`, assert the emitted YAML's structure (parsed back to JSON) matches an expected snapshot. Demonstrates persisted vs sampled provenance side-by-side. |

The accounting-app showcase (existing) gets a docs update referencing how to opt in to `persistJsonSchema` per collection, but no code change.

## Testing strategy

| Surface | Test focus |
|---|---|
| Route B derivation | Zod schema → JSON Schema shape exactly; hash determinism across runs; hash skip on identical re-derive; hash mismatch triggers rewrite; non-Zod validator writes stub envelope; missing `zod-to-json-schema` peer-dep → clear error |
| `_schemas` envelope | Read-after-write round-trip; survives compartment close/reopen; survives `.noydb` bundle write/read; absent envelope handled gracefully |
| `vault.exportJSON()` integration | `schema` field populated when `_schemas/<col>` exists; `schema: null` preserved when not |
| `dumpSchema()` no-stats | Snapshot shape matches `VaultSchemaSnapshot` type; alphabetical ordering at every level; field source provenance correct across persisted/live/sampled/unknown |
| `dumpSchema({ withStats })` | Counters correct (records, bytes, avg/min/max from envelope walk); oldest/newest from `_ts`; no decrypt required for stats; internal collections emitted under `internal:` |
| Sampling fallback | `--sample 50` produces correct inferred types from data; `--sample 0` produces `source: 'unknown'` with no field bodies; enum detection at ≤ 12 unique string values |
| CLI command | Each exit code path; format default; format override; `-o` writes file; stdout default; passphrase resolution priority (flag → env → prompt); auth failure exit 3 |
| YAML emitter | Round-trips through `yaml.parse` to identical structure; alphabetical keys preserved; no comment/anchor edge cases (since we don't emit them) |
| Performance | 100-collection vault dumps in under 5 s with `--with-stats`; hash-skip path measurably faster than write path on no-op re-derive |

## Open questions

1. **Stable field ordering inside a collection.** Spec says alphabetical at every level for diff stability. The persisted JSON Schema may carry its own field order (Zod preserves declaration order). Trade-off: alphabetical = diff-stable; declaration = matches Zod source. **Proposed:** alphabetical in the snapshot; persisted envelope's JSON Schema can keep its declaration order (it's just JSON the emitter doesn't normalise).
2. **Stub envelope for non-opted-in collections.** Should `_schemas/<col>` exist with `{ jsonSchema: null, reason: 'not opted in' }` for collections lacking `persistJsonSchema: true`? **Proposed:** No. Absence of envelope means "not opted in"; presence with `jsonSchema: null` means "opted in but derivation unavailable". Clean distinction.
3. **CLI command name.** `noydb describe <bundle>` is the working name. Alternatives: `noydb dump` (shorter, but `dump` is overloaded with `compartment.dump()`), `noydb describe` (more descriptive of intent), `noydb introspect` (matches the hub primitive). **Proposed:** keep `schema dump` — it parallels `noydb config validate / scaffold` subcommand grouping.
4. **`--with-stats` cost on huge vaults.** Phase 2 walks every envelope to sum bytes. For a 1 M-record vault this is O(n) but the in-memory backend has already loaded everything; cost is iteration, not I/O. Real-cloud adapters (DynamoDB, S3) would pay round-trips. **Proposed:** in v0, `noydb describe` is bundle-only — the bundle is local, so the cost is bounded. A future programmatic call on a live cloud-backed vault is a separate decision.
5. **Subsystem opt-in detection.** Hub doesn't centrally register which `with*()` seams a vault opted into. We'd need to either (a) plumb a registry through hub or (b) inspect compartment state for evidence (presence of MV registry, guard registry, history registry, etc.). **Proposed:** (b) for v0 — read symptoms, not a registry. Simpler; matches what already exists.

## Implementation slices (PR plan)

Three PRs, each independently mergeable into `main` (no long-running branch):

| Slice | Scope | Touches | Est. LOC |
|---|---|---|---|
| **#1 Hub: Route B persistence** | `CollectionOptions.persistJsonSchema`, `_schemas/<coll>` envelope, hash-based dedup, Zod derivation via `zod-to-json-schema` peer-dep, stub envelopes for non-Zod, `vault.exportJSON()` slot fill | `packages/hub/src/collection.ts`, new `packages/hub/src/meta/persisted-schemas/`, `vault.ts` export tweak, `types.ts`, tests | ~250 |
| **#2 Hub: introspection primitive** | `compartment.dumpSchema({ withStats, sampleSize })`, `VaultSchemaSnapshot` types, three-phase walk, sampling fallback, alphabetical ordering | new `packages/hub/src/introspection/`, public re-export, tests | ~400 |
| **#3 CLI: `noydb describe`** | New `schema` subcommand, bundle load + auth resolution, hand-written YAML emitter, JSON emitter, `--with-stats`, `--sample`, `-o`, exit codes | `packages/cli/src/commands/schema.ts`, `bin/noydb.ts` dispatch, tests, showcase | ~250 + showcase |

Each slice has its own success criteria; this spec's "Success criteria" section serves as the umbrella.

## File touchpoints summary

```
packages/hub/
  src/
    collection.ts                                    [edit: CollectionOptions, registration hook]
    vault.ts                                          [edit: exportJSON slot fill, dumpSchema export]
    types.ts                                          [edit: CollectionOptions type]
    meta/
      persisted-schemas/                              [NEW]
        index.ts
        types.ts
        storage.ts
        derive.ts
        canonicalize.ts
    introspection/                                    [NEW]
      index.ts
      types.ts
      walk.ts
      sample.ts
  __tests__/
    meta/persisted-schemas/*.test.ts                  [NEW]
    introspection/*.test.ts                           [NEW]
  package.json                                        [edit: peerDependenciesMeta zod-to-json-schema]

packages/cli/
  src/
    bin/noydb.ts                                      [edit: dispatch 'schema' subcommand]
    commands/
      schema.ts                                       [NEW]
    emit/                                             [NEW]
      yaml.ts
      json.ts
  __tests__/
    schema-dump.test.ts                               [NEW]

showcases/
  schema-dump-with-persisted-validators/              [NEW]
    package.json
    src/index.ts
    expected.yaml

docs/
  subsystems/
    schema-dump.md                                    [NEW]
  core/
    05-schema-and-refs.md                             [edit: cross-link to Route B]
  superpowers/specs/
    2026-05-22-schema-dump-design.md                  [this file]

features.yaml                                         [edit: persisted-json-schema, cli-schema-dump]
```
