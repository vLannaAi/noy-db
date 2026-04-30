# Competitor framework feature-mining (2026-05-01)

> Survey of the offline-first / encrypted / sync / serverless / vector / event-sourced / decentralised / mobile / AI-memory landscape, with every notable feature mined and assigned to one of the 14 (now 15) dimensions. Some competitors define the field; most are look-alikes implementing the same primitives differently. The mining separates **mechanisms worth adopting** from **alternative implementations of the obvious**.

## How to read this

- **§1** lists every competitor I'm aware of, by category, with one-line descriptions.
- **§2** picks the *innovative* ones — those that introduced a primitive nobody else had — and names the singular innovation.
- **§3** is the feature-assignment table. Every row: feature → source(s) → target dimension.
- **§4** identifies a new Dimension 15 the survey clearly warrants (portable identity / federation), plus weaker candidates staged in Dimension 11.
- **§5** lists the most important retrofits to existing dimension files surfaced by the survey.

---

## §1 — The competitor landscape (categorised)

### Local-first / offline-first databases
- **PouchDB / CouchDB** — JS port of CouchDB; document store with bidirectional sync
- **RxDB** — reactive document DB with pluggable storage adapters and replication plugins
- **Dexie.js** — IndexedDB wrapper with reactive queries
- **lokijs** — in-memory JS DB with persistence adapters
- **NeDB** — embedded JSON store (deprecated but influential)
- **TinyBase** — in-memory tabular DB with queries, indexes, undo/redo, metrics
- **WatermelonDB** — React Native lazy-loading DB with sync protocol
- **MMKV** — mmap-based mobile KV store (Tencent), encrypted variant
- **ObjectBox** — object-oriented mobile DB with sync
- **Realm / MongoDB Atlas Device Sync** — mobile object DB with encryption + cloud sync
- **Riffle** (Notion) — local-first reactive DB experiment
- **DXOS** — P2P collaborative apps framework with ECHO database
- **Earthstar** — P2P shared documents

### CRDT / sync engines
- **Automerge** — JSON CRDT with first-class history and operational sync
- **Yjs** — shared types (Map/Array/Text) with awareness protocol and subdocs
- **ElectricSQL** — Postgres-to-SQLite live sync with shape-based partial replication
- **Triplit** — full-stack triplestore with real-time subscriptions and SQL-flavoured queries
- **InstantDB** — schemaless triplestore with React-first DX and optimistic mutations
- **Zero** (Replicache successor by Rocicorp) — server-authoritative CRDTs with rendered views
- **Replicache** — sync engine with mutators and pull/push protocol
- **PowerSync** — Postgres → SQLite via stream service
- **TanStack DB** (announced) — local-first framework
- **crsqlite** — CRDT extension for SQLite
- **Crepe / cr-sqlite** — variants
- **OrbitDB** — IPFS-based databases (KV, log, docstore, counter)
- **Gun.js** — graph DB with P2P sync and SEA decentralized auth
- **Hyperbee / Hyperdrive** (Holepunch / Pear) — P2P databases with DHT discovery, blockchainless

### Encrypted / zero-knowledge databases
- **SQLCipher** — encrypted SQLite (page-level AES)
- **Tink** (Google) — crypto library with key management primitives
- **MongoDB CSE** (Client-Side Field Level Encryption) — queryable encrypted fields
- **Filen** — encrypted cloud storage with metadata encryption
- **Cryptomator** — vault-based encryption over S3/WebDAV/local
- **Proton Drive** — zero-knowledge cloud storage with sharing
- **Tresorit** — zero-knowledge enterprise file sharing
- **Internxt** — open-source encrypted cloud
- **Standard Notes** — E2EE notes with encrypted extension distribution
- **Notesnook** — zero-knowledge notes with monographs (read-only published views)
- **Joplin** — encrypted notes with multi-target sync and OCR
- **Bitwarden / 1Password / KeePassXC** — encrypted credential vaults
- **Vault by HashiCorp** — secrets management with leases and dynamic secrets

### Edge databases / serverless
- **Cloudflare D1 / Durable Objects / Hyperdrive / Vectorize** — edge-native data stack
- **Turso / libSQL** — replicated SQLite for edge
- **Deno KV** — Deno Deploy's built-in KV
- **Vercel KV / Vercel Blob / Vercel Postgres** — Vercel's data layer
- **Netlify Blobs** — Netlify's edge KV
- **Fly Volumes / Fly Replicas** — Fly.io's regional state
- **Upstash** — Redis / Kafka / QStash on edge

### Vector / embedding databases
- **Pinecone** — managed vectors with namespaces and hybrid search
- **Weaviate** — vectors + structured + GraphQL
- **Qdrant** — vector + payload filters + quantization + sharding
- **Chroma** — in-process vector DB with embedding functions, multi-modal
- **LanceDB** — embedded columnar vector DB with version control on data
- **Milvus** — distributed vector DB (cloud + self-host)
- **pgvector** — Postgres extension
- **sqlite-vec** — SQLite vector extension
- **Vespa** — Yahoo's vector + relational
- **Marqo** — multi-modal embedded search

### BaaS / serverless backends
- **Firebase** — Firestore + Auth + Functions + Hosting + Remote Config
- **Supabase** — Postgres + Auth + Storage + Realtime + Edge Functions + pgvector
- **Pocketbase** — single-binary BaaS on SQLite with admin UI, hooks, OAuth
- **Appwrite** — open BaaS with auth/databases/storage/functions/messaging
- **Convex** — typed reactive backend with scheduled actions, file storage, vector search
- **Hasura** — GraphQL on Postgres with permissions and event triggers
- **Parse Platform** — open-source mobile BaaS (post-Facebook)
- **Xata** — serverless Postgres with built-in search
- **Nhost** — open Firebase alternative on Postgres + Hasura
- **InstantDB** (also CRDT category) — full BaaS shape

### P2P / federated / decentralised protocols
- **ATProto / Bluesky** — DID identity, lexicons, signed Merkle DAG repos, PDS portability
- **Solid** (Tim Berners-Lee) — pods + WebID + WAC + LDP
- **Nostr** — event-based protocol with signed records and relay-based distribution; NIPs for extension
- **Matrix** — federated messaging with E2EE and decentralised state
- **ActivityPub** — federated social (Mastodon, Pixelfed)
- **DXOS** (also local-first) — P2P collaborative ECHO database
- **Earthstar** — share documents over multiple replicas
- **Holepunch / Pear** — P2P apps platform with Hyper* primitives

### Decentralised storage
- **IPFS** — content-addressed P2P file system
- **Arweave** — permanent storage (one-time fee)
- **Filecoin** — incentivised IPFS
- **Storj / Sia / Skynet** — decentralised storage networks
- **Ceramic / OrbisDB** — decentralised mutable streams on IPFS
- **Internet Computer (DFINITY)** — chain-as-compute platform

### Time-series / event-sourced
- **EventStoreDB / Kurrent** — event-sourced DB with projections and `$by_*` system streams
- **Materialize** — streaming materialized views with SQL on streams, exactly-once
- **Apache Kafka / KSQL** — log + stream processing
- **TigerBeetle** — financial double-entry event store with built-in invariants
- **Datomic** — immutable, time-travel, Datalog query
- **InfluxDB** — time-series for sensor / metrics
- **TimescaleDB** — PG extension for time-series
- **QuestDB** — financial time-series, lock-free
- **ClickHouse / DuckDB / MotherDuck** — analytical columnar

### Graph / multi-model
- **Neo4j / Memgraph / DGraph** — graph DBs (Cypher / GraphQL)
- **EdgeDB** — graph-relational with EdgeQL
- **SurrealDB** — multi-model (graph, relational, document) with SQL-like
- **FaunaDB** — relational + graph + temporal serverless
- **Dolt** — git-like SQL (branches, merges)

### Document management / personal knowledge
- **Anytype** — object-oriented PKM with P2P-first (Anysync) and graph relations
- **Logseq** — outliner with block-references, file-based, WASM plugins
- **Obsidian** — markdown vault with plugins, paid sync, paid publish
- **Dendron / Foam** — VSCode-based markdown PKM
- **Reflect / Roam Research** — networked thought tools
- **Paperless-ngx** — self-hosted document management with OCR

### AI memory / RAG stacks
- **mem0** — memory layer for LLMs (vector + summarization + retrieval)
- **Letta** (formerly MemGPT) — stateful agents with hierarchical memory
- **Zep** — long-term memory store with summarization
- **LangChain memory** — conversation buffer, summary, vector retrieval
- **LlamaIndex** — RAG-focused indexing + query
- **Vellum / LangSmith / Helicone** — LLM observability and evals

### Type-safe data / ORMs / query builders
- **Drizzle ORM** — TypeScript-first ORM
- **Prisma** — ORM with migrations + studio
- **Kysely** — typed query builder
- **Effect-DB / Effect Schema** — FP-style data layer
- **Zero, Triplit, InstantDB, Convex** — typed reactive surfaces (also above)

### Sandboxing / capability-based
- **Sandstorm** — sandboxed apps with capability-based access (defunct but influential)
- **Tildes / Permaweb** — capability-style models

---

## §2 — Most innovative (Tier S and A)

The Tier S list is where a competitor *introduced a primitive nobody else had*. The Tier A list is where a competitor *combined existing primitives in a uniquely useful way*.

### Tier S — defines a primitive

| Competitor | The singular innovation |
|---|---|
| **Automerge** | Operational JSON CRDT with first-class history; the rare CRDT that gives you an undo/redo log instead of a state snapshot. *Worth adopting:* the op-log-as-stream model. |
| **ATProto** | DID-based identity decoupled from any specific service, lexicons (typed protocol descriptions), signed Merkle DAG repos that the user owns and can move between PDSes. *Worth adopting:* portable identity, signed records, lexicon contract. |
| **ElectricSQL** | Shape-based partial replication: declare which subset of Postgres you want on the client, and the sync engine handles the rest. *Worth adopting:* declarative replication shapes. |
| **Holepunch / Hyperbee** | P2P databases with DHT discovery and *no* blockchain — durability via replication, not consensus. *Worth adopting:* DHT-based peer discovery, block-tree replication. |
| **TigerBeetle** | Double-entry accounting as a first-class storage shape with built-in invariants and event-sourcing for financial precision. *Worth adopting:* domain-specific data shape with semantic invariants baked in. |
| **Convex** | Server-side scheduled actions + file storage + vectors + reactive queries unified under one typed runtime. *Worth adopting:* the cohesion of "data + scheduled work + derivations" as one model. |
| **Datomic** | Immutable database with time-travel queries (`as-of`, `since`) and Datalog. *Worth adopting:* time-travel as a first-class query primitive. |
| **Materialize** | Streaming materialized views: declare a SQL query, get an always-up-to-date result that updates incrementally. *Worth adopting:* incremental materialized views over streams. |
| **Sandstorm** | Capability-based app sandboxing where each app gets exactly the capabilities it declares. *Worth adopting:* capability-token model for plugin / third-party access. |

### Tier A — uniquely useful combination

| Competitor | The standout combination |
|---|---|
| **Triplit** | Full-stack triplestore with real-time subscriptions, schema-as-code, server *and* client unified. |
| **Zero (Rocicorp)** | Server-authoritative CRDTs with "rendered views" and optimistic mutations; the missing piece between Replicache and Materialize. |
| **Pocketbase** | Single-binary BaaS with admin UI; the most ergonomic small-app server in the field. |
| **InstantDB** | Schemaless triplestore with React-first DX and JSX-aware queries. |
| **LanceDB** | Embedded columnar vector DB with *git-like data versioning*. |
| **Standard Notes** | Encrypted extension distribution: third-party themes/extensions ride the same E2EE channel as the data. |
| **Cryptomator** | Vault-based encryption with name-encryption (no metadata leak via filenames). |
| **Notesnook** | "Monographs" — public read-only published views derived from encrypted source. |
| **mem0 / Letta / Zep** | Hierarchical agent memory: short-term, long-term, working, episodic, with summarization and retrieval as primitives. |
| **Crsqlite** | CRDT extension *for* SQLite — bringing offline-first to the most ubiquitous embedded DB. |
| **Yjs** | Awareness protocol for live collaboration metadata (cursors, selections) separate from durable data. |
| **Logseq** | WASM plugins with sandboxed execution. |
| **Anytype** | Object-oriented data with type-as-data (types and templates are first-class objects). |

---

## §3 — Feature mining table

Every row: feature → sources → target dimension. Where a feature suggests a *new* primitive in an existing dimension, the cell names it.

### Storage / backends → Dimension 01

| Feature | Source(s) | Assignment |
|---|---|---|
| Mmap-based KV for native | MMKV, ObjectBox | Dim 01 — `to-mmap-native` for Capacitor/Tauri |
| Single-binary BaaS shape | Pocketbase | Dim 01 — packaging story; possible `to-pocketbase` adapter |
| Branchable data (git-like) | Dolt, LanceDB | Dim 11 catch-all → grow into branching primitive |
| Edge-native multi-region | Cloudflare D1 + Durable Objects | Dim 01 already has CF; add `to-durable-object` for stateful coordination |
| Stream-service replication | PowerSync | Dim 12 (streams) — replication-as-stream pattern |
| DHT-based peer discovery | Holepunch, IPFS | Dim 05 (`by-discovery`) — already proposed |
| Permanent (one-time-fee) storage | Arweave, Filecoin | Dim 01 — already proposed `to-arweave`, `to-filecoin` |
| Capability-driven storage routing | Sandstorm | Dim 02 — capability-based access |
| Name-encryption (filename privacy) | Cryptomator | Dim 01 — capability flag `nameEncrypted: true` for object-store backends |
| Block-level deduplication | restic, BorgBackup | Dim 01 — capability `dedup: 'block' \| 'file' \| 'none'` |
| Erasure coding for redundancy | Storj, Sia | Dim 01 — `redundancy: 'erasure-coded'` capability extension |

### Auth / identity → Dimension 02 + new Dimension 15

| Feature | Source(s) | Assignment |
|---|---|---|
| DID-based portable identity | ATProto, Solid, Nostr | **NEW Dim 15** — portable identity & federation |
| Web of trust / social attestation | Keybase, ATProto trust graph | Dim 15 |
| Capability tokens with embedded perms | UCAN, AWS pre-signed URLs | Dim 02 — `on-ucan`, `on-presigned` |
| Signed records / per-record signatures | ATProto, Nostr | Dim 15 — every record carries an issuer signature |
| Federation-aware unlock | Solid, Matrix | Dim 15 |
| Lease-based dynamic credentials | HashiCorp Vault | Dim 02 — `on-vault-lease` |
| Encrypted extension distribution | Standard Notes | Dim 11 (plugin manifest) — extensions ride the data channel |
| Social key recovery | Keybase, Web3 wallets | Dim 02 — extends `on-shamir` |
| Magic-link recipient slots | Existing noy-db magic-link | Already shipped (no addition) |

### Exports / interop → Dimension 03

| Feature | Source(s) | Assignment |
|---|---|---|
| GraphQL surface as an export shape | Hasura, Weaviate | Dim 10 (SQL surface) → grow into "query surfaces" with GraphQL as a sibling |
| Lexicon-typed wire format | ATProto | Dim 15 — protocol-level cross-app interop |
| ActivityPub federation outbox | ActivityPub | Dim 15 — federation protocol |
| OPDS / catalog feeds | Calibre, OPDS | Dim 03 — `as-opds` for digital-library interop |
| Markdown export with frontmatter | Obsidian, Logseq | Dim 03 — `as-md` already proposed; add frontmatter sub-config |

### Integrations / surfaces → Dimension 04

| Feature | Source(s) | Assignment |
|---|---|---|
| WASM plugin sandbox | Logseq, Wasmer | Dim 11 plugin-manifest grows; possibly NEW dim if sandbox-class |
| Generated admin UI | Pocketbase, Hasura, Appwrite, PB | Dim 04 — new `in-admin-ui` (auto-generated CRUD + auth + audit) |
| React Native primitives | WatermelonDB, Realm | Dim 04 — `in-react-native` |
| Capacitor / Cordova / Tauri / Electron bridges | Many | Dim 04 — `in-capacitor`, `in-tauri`, `in-electron` |
| Server actions / mutators (Replicache) | Zero, Replicache | Dim 04 — `in-replicache-mutators` adapter |
| LLM tool-use protocol | Anthropic, OpenAI, MCP | Dim 04 — `in-ai` already; add MCP server adapter |
| MCP server exposing vault | Anthropic MCP | Dim 04 — new `in-mcp-server` |

### Transports / collaboration → Dimension 05

| Feature | Source(s) | Assignment |
|---|---|---|
| Awareness protocol (cursors/selection) | Yjs | Dim 05 — `by-awareness` (separate from data sync) |
| Federation outbox / inbox | ActivityPub, Matrix | Dim 15 |
| Relay-as-protocol (Nostr) | Nostr | Dim 05 — `by-nostr-relay` adapter |
| ActivityPub fanout | ActivityPub | Dim 15 |
| Matrix federation | Matrix | Dim 15 |

### Observability → Dimension 06

| Feature | Source(s) | Assignment |
|---|---|---|
| LLM-specific telemetry (token cost, latency) | LangSmith, Helicone | Dim 06 — extend `to-meter` with LLM-specific signals |
| Recall / hit-rate metrics for vectors | Pinecone observability | Dim 06 + Dim 13 |
| Sync-lag per replica | ElectricSQL, PowerSync | Dim 06 — sync metrics |
| Conflict-rate metering | Yjs, Replicache | Dim 06 — CRDT conflict frequency |
| Query plan explain | Datomic, FaunaDB | Dim 10 (SQL surface) — `EXPLAIN` |

### Domain primitives → Dimension 07

| Feature | Source(s) | Assignment |
|---|---|---|
| Double-entry as a primitive | TigerBeetle | Dim 07 — `withDoubleEntry({ debit, credit })` |
| Reservation-based serial numbers | TigerBeetle, accounting systems | Dim 07 — already proposed (`withSerialSequence`) |
| Time-travel queries (`as-of`) | Datomic, FaunaDB, Dolt | Dim 11 catch-all (already proposed) → graduate |
| Branching data (git-like) | Dolt | Dim 11 catch-all → graduate |
| Append-only with retention | EventStoreDB, Kafka, Materialize | Dim 12 (already proposed) |
| Type-as-data (templates as objects) | Anytype | Dim 11 — schema-as-data |
| Lexicons (typed protocol contracts) | ATProto | Dim 15 |
| Validators with custom error reporting | Effect Schema, Zod | Dim 07 — error-shape design choice |

### Defence → Dimension 08

| Feature | Source(s) | Assignment |
|---|---|---|
| Capability-based app sandboxing | Sandstorm | NEW or Dim 02 — capability tokens for third-party apps |
| WASM-isolated plugins | Logseq | Dim 04 — sandboxed plugin runtime |
| Audit log of every operation | Datomic, EventStoreDB | Dim 11 — already partial via `withHistory`; extend |
| Tamper-evidence tells | Various DRM literature | Dim 08 — already covered in (8a) |
| Burnable one-shot credentials | UCAN, AWS pre-signed | Dim 08 — already covered in (8b) |

### Viewers / read-only access → Dimension 09

| Feature | Source(s) | Assignment |
|---|---|---|
| "Monographs" — published read-only views | Notesnook | Dim 09 — published-share variant |
| Diff / change visualization | Datomic, Dolt | Dim 09 — built-in diff renderer |
| Federated search across multiple vaults | ATProto network search | Dim 11 catch-all (cross-vault joins) |
| Public anonymous viewer (no auth) | Pastebin / Notesnook monograph | Dim 09 — `public: true` viewer mode |

### Query surfaces → Dimension 10

| Feature | Source(s) | Assignment |
|---|---|---|
| Datalog query | Datomic | Dim 10 — `in-datalog` sibling to `in-sql` |
| GraphQL surface | Hasura, Weaviate, EdgeDB | Dim 10 — `in-graphql` sibling |
| Cypher (graph) query | Neo4j, Memgraph | Dim 10 — `in-cypher` if graph data shape lands |
| EdgeQL | EdgeDB | Dim 10 — alternative query DSL |
| JSX-as-query (live React) | InstantDB | Dim 04 + Dim 10 — react-aware query layer |
| Streaming SQL (`SELECT ... STREAM`) | Materialize, KSQL | Dim 12 + Dim 10 — windowed aggregates over streams |

### Catch-all → Dimension 11

| Feature | Source(s) | Assignment |
|---|---|---|
| Time-travel / `as-of` queries | Datomic, FaunaDB, Dolt | Dim 11 — already proposed; graduate |
| Branching data | Dolt | Dim 11 — already proposed |
| Soft-delete defaults | Many | Dim 11 — already proposed |
| Schema migrations | Drizzle, Prisma, Convex | Dim 11 — already proposed |
| Hooks / triggers / event reactions | Pocketbase, Hasura, Convex, Firebase | Dim 11 — new sub-section, may graduate |
| Scheduled actions / cron | Convex, Cloudflare Workers cron | Dim 11 — pairs with hooks |
| Plugin manifest with conformance | (proposed already) | Dim 11 — already proposed |
| Test-harness packaging for adapters | (proposed already) | Dim 11 — already proposed |
| Schema-as-data (types are objects) | Anytype | Dim 11 |
| Pluggable crypto algorithms / PQC | Tink, future-proof concerns | Dim 11 — staging until urgent |

### Streams → Dimension 12

| Feature | Source(s) | Assignment |
|---|---|---|
| Op-log-based CRDT (not state-based) | Automerge | Dim 12 — already covered |
| Subscriptions / `$by_*` projections | EventStoreDB, KurrentDB | Dim 12 — projections as derived views |
| Exactly-once delivery | Materialize, Kafka with txn | Dim 12 — non-goal noted; reconsider |
| Awareness protocol | Yjs | Dim 05 |
| Conflict-rate metrics | Replicache, Zero | Dim 06 |

### Embeddings / vectors → Dimension 13

| Feature | Source(s) | Assignment |
|---|---|---|
| Hybrid sparse+dense search | Pinecone, Weaviate, Vespa | Dim 13 — hybrid query mode |
| Quantization (int8, binary) | Qdrant, Pinecone | Dim 13 — already in open questions |
| Multi-modal embeddings (image, audio) | Chroma, Marqo | Dim 13 — already noted |
| Data versioning on vectors | LanceDB | Dim 13 — extends `withHistory` for vectors |
| Payload filtering at kNN time | Qdrant | Dim 13 — `.similarTo(v).where(...)` predicate |
| Embedding-function-as-data | Chroma | Dim 13 — register encoders in vault config |
| Hierarchical / agentic memory | mem0, Letta, Zep | Dim 13 + Dim 14 — memory tiers as derivations |

### Derived data / lifecycle → Dimension 14

| Feature | Source(s) | Assignment |
|---|---|---|
| MapReduce views | CouchDB, PouchDB | Dim 14 — materialized view via map/reduce |
| Streaming materialized views | Materialize | Dim 14 — incremental; pairs with Dim 12 |
| Scheduled refresh | Convex, Cloudflare cron | Dim 14 — `refresh: { every: '1h' }` |
| File-derived metadata extraction | Paperless-ngx | Dim 14 — already covered; OCR as deriver |
| Image transformations on the read path | Cloudinary, Imgix | Dim 14 — `transformations` capability already covered |
| Summarization derivations (LLM) | mem0, Zep | Dim 14 — non-deterministic derivation, persisted |
| "Rendered views" (server-authoritative materialization) | Zero | Dim 14 + Dim 12 — server-side pre-rendered queries |

### Portable identity / federation → NEW Dimension 15

| Feature | Source(s) | Assignment |
|---|---|---|
| DID-based identity decoupled from service | ATProto, Solid, Veramo | Dim 15 |
| Lexicons (typed protocol descriptions) | ATProto | Dim 15 |
| Signed records (per-event signatures) | Nostr, ATProto | Dim 15 |
| Repo portability (move data between PDSes) | ATProto, Solid pods | Dim 15 |
| Federation outbox/inbox protocol | ActivityPub, Matrix | Dim 15 |
| Web of trust attestation | Keybase, ATProto graph | Dim 15 |
| Relay-discoverable content | Nostr | Dim 15 |
| WebID + WAC | Solid | Dim 15 |
| UCAN capability tokens | Fission, IPFS UCAN | Dim 15 + Dim 02 |

---

## §4 — New dimensions identified by the survey

### Dimension 15 (proposed, written): Portable identity and federation

This is the only new dimension the survey *clearly* warrants. The signals: ATProto, Solid, Nostr, Matrix, ActivityPub, UCAN, and Veramo all converge on the same architectural axis — *the user's identity and data must live independently of any single service*. None of the existing 14 dimensions name this primitive.

Written as `15-portable-identity.md` (file added below).

### Weak candidates (staged, not promoted)

These came up in the survey but don't yet have enough independent signal to justify their own file:

- **Sandboxed plugin execution** (Logseq WASM, Sandstorm). One source plus a partial pattern. Stages into Dim 11 plugin-manifest until 3+ ideas accrete.
- **Branching data / time-travel as a unified concept** (Datomic, Dolt, LanceDB). Three sources, but each implements differently. Stages into Dim 11 with explicit promotion criteria.
- **Hooks / triggers / scheduled actions** (Pocketbase, Hasura, Convex, Firebase). Strong signal but cleanly fits as Dim 11 catch-all entries; promote when scope grows.
- **Generated admin UI** (Pocketbase, Hasura, Appwrite). Single primitive across three sources but consumed by users not architecture; stages as a Dim 04 entry (`in-admin-ui`).

---

## §5 — Existing dimensions that need retrofit

The survey surfaced features that should land directly into existing dimension files. Retrofits applied in this commit:

- **Dim 01:** name-encryption capability flag, block-level dedup, erasure coding, mmap-native backend
- **Dim 02:** UCAN / pre-signed capability tokens, lease-based dynamic credentials, social key recovery
- **Dim 04:** `in-admin-ui`, `in-mcp-server`, `in-react-native`, `in-capacitor`/`in-tauri`/`in-electron`, `in-replicache-mutators`
- **Dim 05:** `by-awareness` (Yjs awareness protocol), `by-nostr-relay`
- **Dim 06:** LLM-specific telemetry, sync-lag, conflict-rate metering
- **Dim 07:** `withDoubleEntry` (TigerBeetle-shaped), error-shape choice
- **Dim 09:** monograph / published-read-only mode, diff renderer
- **Dim 10:** `in-datalog`, `in-graphql`, `in-cypher` siblings; `EXPLAIN` for SQL
- **Dim 11:** hooks/triggers/scheduled actions added; schema-as-data noted
- **Dim 12:** projections as derived views; awareness protocol cross-ref
- **Dim 13:** hybrid sparse+dense, payload filtering at kNN, hierarchical memory
- **Dim 14:** map/reduce views, streaming materialized views, "rendered views" (Zero)

---

## §6 — Self-assessment

What this survey is *not*: a competitive-positioning document, a marketing analysis, or a feature-parity checklist. It is a *mining report* — each row identifies a primitive worth considering, with explicit dimension assignment so the catalog stays coherent. Rejected features (paid-only services, enterprise-only patterns, primitives that conflict with the zero-knowledge invariant) are deliberately not surfaced; the mission filter applies.

What this survey *is missing*:
- No depth on each competitor's *actual implementation* — surface-level only. Deep dives happen per-dimension when each graduates to its own brainstorming pass.
- No quantitative ranking of features by adoption / market share — that's BizDev work, not architecture.
- Possibly missing newer entrants in the AI-memory and edge-DB space; revisit at next major brainstorm.
