# Dimension 01 — Storage backends (`to-*`)

## Purpose

Cover the entire reachable landscape of free-tier and inexpensive serverless storage so that every reasonable target deployment for a small app — single user, SME, small group — can land on a noy-db backend without paying for SaaS. Provide both **generic-protocol** stores (REST/S3/WebDAV/SFTP) and **native-SDK** stores (cloud-vendor-optimised) so adopters trade off portability vs performance.

## Current state

21 packages: `to-memory`, `to-file`, `to-browser-local`, `to-browser-idb`, `to-aws-dynamo`, `to-aws-s3`, `to-cloudflare-r2`, `to-cloudflare-d1`, `to-supabase`, `to-postgres`, `to-mysql`, `to-sqlite`, `to-turso`, `to-webdav`, `to-ssh`, `to-smb`, `to-nfs`, `to-icloud`, `to-drive`, `to-probe`, `to-meter`. Capability metadata (`casAtomic`, `auth`) exists; conformance suite exists.

## Target state

A free-tier coverage matrix that answers "**which backend should I use if I have $0 to spend and N users in region R?**" for every plausible region/scale. Native + generic split so the same vault can move from `to-webdav` (zero-vendor-lock) to `to-aws-dynamo` (CAS-native, cheaper at scale) without app changes. Capability metadata extended with **region**, **latency tier**, **blob-vs-record specialisation**, **cost-per-op estimate**, **redundancy posture**.

## Concrete additions

**Cloud-vendor backends (native SDK):**
- `to-azure-blob` — Azure Blob Storage (5GB free tier, hot/cool/archive tiers)
- `to-azure-cosmos` — Cosmos DB (1000 RU/s free)
- `to-azure-table` — Azure Table Storage (low-cost K/V)
- `to-gcp-storage` — GCS (5GB free)
- `to-gcp-firestore` — Firestore (1GB / 50k r/d)
- `to-mongodb` — MongoDB Atlas (512MB free)
- `to-redis` — Redis Cloud (30MB free) / Upstash (10k req/d free)

**Edge-tier backends (free or near-free):**
- `to-deno-kv` — Deno Deploy KV
- `to-vercel-blob` / `to-vercel-kv` — Vercel free tier
- `to-netlify-blobs` — Netlify free tier
- `to-fly-volume` — Fly.io free volumes
- `to-fauna` — FaunaDB free tier
- `to-planetscale` — PlanetScale free tier (if reinstated)
- `to-neon` — Neon Postgres free tier (already partially via `to-postgres`?)

**Decentralised storage (anchor-only / content-addressed):**
- `to-ipfs` — IPFS pinning service
- `to-arweave` — permanent storage (one-time fee)
- `to-filecoin` — paid retrieval, free pinning via providers
- `to-anchor-eth` — Merkle-root-only on-chain anchoring (NOT plaintext or ciphertext on-chain)

**Generic-protocol stores (already partially covered, expand):**
- `to-https` — generic HTTP PUT/GET endpoint (covers DIY backends)
- `to-pubsub-store` — store via pub/sub topic + cache (NATS/MQTT)
- `to-mmap-native` — mmap-backed KV (MMKV / ObjectBox / LMDB lineage); for native hosts via Capacitor/Tauri/Electron bridges
- `to-pocketbase` — PocketBase as a backing store (already-deployed BaaS instances)
- `redundancy: 'erasure-coded'` — capability flag for Storj / Sia-class backends

**Capability-metadata expansion (no new package, all existing):**
- `region: 'us-east' | 'eu-west' | ...` — for compliance routing
- `latencyTier: 'edge' | 'regional' | 'cross-region'` — observable expectation
- `shape: 'record' | 'blob' | 'stream' | 'embedding' | 'multi'` — drives `routeStore` selection. `stream` and `embedding` are *new data shapes* (see Dimensions 12 + 13); `multi` declares a backend that handles more than one shape natively (e.g., `to-postgres` with `pgvector` extension is `multi: ['record', 'embedding']`)
- `costPerOp: { read: number, write: number, storage: number }` — for `to-advisor`
- `redundancy: 'single' | 'multi-az' | 'multi-region'` — durability posture
- `tier: 'primary' | 'derived' | 'cache'` — declares the lifecycle role of the backend (Dimension 14): primaries store source data; derived backends store regeneratable derivations; cache backends are expungable
- `expungable: boolean` — backend supports cheap delete-and-regenerate semantics (CDN caches, ephemeral blob)
- `transformations?: string[]` — for CDN-class backends, declares supported on-the-fly transforms (resize, format-convert)
- `nameEncrypted: boolean` — backend stores object names as opaque ciphertext (Cryptomator-style; prevents filename-leak via key listing)
- `dedup: 'block' | 'file' | 'none'` — backend supports content-addressed deduplication (restic / Borg-style block-level; useful for blobs and bundles)
- `identityAware: boolean` — backend can index records by issuer DID for federated repos (relevant for Dimension 15)

## Non-goals & tradeoffs

- **Paid-only services without a free quota.** Snowflake, BigQuery, Datadog: no.
- **Re-implementing crypto in the store layer.** Stores see only ciphertext; that invariant is non-negotiable.
- **Public-chain ciphertext storage.** Gas costs + permanence violate both economic and privacy targets. Anchor-only is the compromise.
- **Sub-50ms latency guarantees.** noy-db is a memory-first design; backend latency is rarely the bottleneck.

## Dependencies / sequencing

- Capability-metadata expansion blocks `to-advisor` (Dimension 06). Land first.
- Bundle-size CI gate (in 1.0 gate) must accommodate the new packages.
- Conformance suite (`runStoreConformanceTests`) extended for new capability dimensions.

## Cross-references

- `features.yaml` → `adapters` (one entry per new package), `topologies` (for hybrid combinations)
- Related: Dimension 06 (advisor consumes capability metadata), Dimension 05 (some `by-*` transports overlap with `to-pubsub-store`), Dimension 12 (`to-stream-*` backends), Dimension 13 (`to-vector-*` backends), Dimension 14 (`to-cache-*` backends + `tier`/`expungable`/`transformations` capability extensions)
- Spec anchor: `SUBSYSTEMS.md#stores`

## Open questions

- **Granularity of `region`.** ISO country code, AWS-style region, or freeform tag?
- **Shape-vs-package split.** Does shape specialisation live at the package level (`to-aws-s3` for blobs, `to-aws-dynamo` for records, `to-stream-s3` for streams, `to-vector-pgvector` for embeddings) or as capability flags multi-shape backends can carry? See Dimensions 12 + 13 for the streams/embeddings discussion.
- **Hybrid routing.** Today's `routeStore` picks one backend per collection. Should there be automatic spillover (records to A, blobs to B, fallback to C if A fails)?
- **Anchor-on-chain vs full decentralised storage.** Is `to-anchor-eth` worth a package, or is it better as a `with*()` strategy invoked alongside any store?
