# Deployment profiles

NOYDB supports many topologies. Pick the one that matches your stack.

> Related: [Roadmap](../ROADMAP.md) · [Architecture](./architecture.md) · [Adapters](./adapters.md) · [Getting started](./getting-started.md)

---

## Quick selection

| Use case                     | core | file | dynamo | s3 | browser | vue |
|------------------------------|:----:|:----:|:------:|:--:|:-------:|:---:|
| USB / local disk             |  ✓   |  ✓   |        |    |         |     |
| Cloud only                   |  ✓   |      |   ✓    |    |         |     |
| Offline-first + cloud sync   |  ✓   |  ✓   |   ✓    |    |         |     |
| Browser SPA                  |  ✓   |      |        |    |    ✓    |     |
| Browser + cloud sync         |  ✓   |      |   ✓    |    |    ✓    |     |
| S3 archive                   |  ✓   |      |        | ✓  |         |     |
| Vue/Nuxt full stack          |  ✓   |  ✓   |   ✓    |    |         |  ✓  |
| Testing / dev                |  ✓   |      |        |    |         |     |

---

## 1. USB stick (offline only)

```bash
npm install @noy-db/core @noy-db/file
```

```mermaid
flowchart LR
    App["Application<br/>createNoydb({ adapter: jsonFile })"]
    File["@noy-db/file"]
    USB[("USB drive<br/>/Volumes/USB/noydb-data/")]
    App --> File --> USB
```

**Use case:** Accountant carries client data on USB between office and home.
**Pros:** Zero internet, fully portable, works anywhere.
**Cons:** Single device, no sync, USB loss = rely on backups.

---

## 2. Cloud only (DynamoDB)

```bash
npm install @noy-db/core @noy-db/dynamo
```

```mermaid
flowchart LR
    App["Application<br/>createNoydb({ adapter: dynamo })"]
    Dyn["@noy-db/dynamo"]
    DDB[("DynamoDB<br/>noydb-prod<br/>ap-southeast-1")]
    App -->|HTTPS| Dyn --> DDB
```

**Use case:** Cloud-native app with always-on connectivity.
**Pros:** Managed infra, multi-device.
**Cons:** Requires internet, AWS dependency.

---

## 3. Offline-first + cloud sync

```bash
npm install @noy-db/core @noy-db/file @noy-db/dynamo
```

```mermaid
flowchart LR
    App["Application"]
    Local["@noy-db/file<br/>(LOCAL primary)"]
    Sync(("sync engine<br/>push/pull"))
    Remote["@noy-db/dynamo<br/>(REMOTE secondary)"]
    App --> Local
    Local <--> Sync
    Sync <--> Remote
```

**Sync flow:**

```mermaid
sequenceDiagram
    participant App
    participant Local as @noy-db/file
    participant Sync as Sync engine
    participant Remote as @noy-db/dynamo

    App->>Local: write record
    Local->>Local: + dirty log
    Note over App,Remote: Online
    Sync->>Local: read dirty entries
    Sync->>Remote: push (expectedVersion check)
    Remote-->>Sync: ok / conflict
    Sync->>Remote: pull remote changes
    Remote-->>Sync: encrypted records
    Sync->>Local: merge by version
```

**Use case:** Regional accounting firm — USB at home, DynamoDB at office, auto-sync.
**Pros:** Best of both worlds, works offline, syncs when available.
**Cons:** Conflicts possible (mitigated by strategies).

---

## 4. Browser app with local cache

```bash
npm install @noy-db/core @noy-db/browser
```

```mermaid
flowchart LR
    SPA["SPA / PWA<br/>createNoydb({ adapter: browser })"]
    B["@noy-db/browser"]
    LS[("localStorage (< 5MB)")]
    IDB[("IndexedDB (> 5MB)")]
    SPA --> B
    B --> LS
    B --> IDB
```

**Use case:** Personal finance app, offline PWA.
**Pros:** Zero server, instant load, works offline.
**Cons:** Browser storage limits, single device.

---

## 5. Browser + cloud sync

```bash
npm install @noy-db/core @noy-db/browser @noy-db/dynamo
```

```mermaid
flowchart LR
    SPA["Vue/Nuxt SPA"]
    B["@noy-db/browser<br/>(LOCAL cache)"]
    Sync(("auto-sync<br/>online/offline"))
    Dyn["@noy-db/dynamo<br/>(REMOTE)"]
    SPA --> B
    B <--> Sync
    Sync <--> Dyn
```

**Use case:** Multi-device web app with offline capability.
**Pros:** Instant hydration from cache, multi-device via cloud.
**Cons:** Browser storage limits for large datasets.

---

## 6. S3 archive

```bash
npm install @noy-db/core @noy-db/s3
```

```mermaid
flowchart LR
    App["Application<br/>createNoydb({ adapter: s3 })"]
    S3A["@noy-db/s3"]
    S3[("S3 bucket<br/>noydb-archive<br/>ETags for concurrency")]
    App -->|HTTPS| S3A --> S3
```

**Use case:** Long-term encrypted archival, bulk backup.
**Pros:** Cheapest storage, lifecycle policies, versioning.
**Cons:** Higher latency than DynamoDB; not ideal for frequent writes.

---

## 7. Vue / Nuxt full stack (production target)

```bash
npm install @noy-db/core @noy-db/file @noy-db/dynamo @noy-db/vue
# v0.3+: also @noy-db/pinia and @noy-db/nuxt
```

```mermaid
flowchart TB
    subgraph Nuxt["Nuxt Application"]
        Composables["useNoydb / useCollection /<br/>useQuery / useSync<br/>(or @noy-db/pinia stores in v0.3+)"]
        Core["@noy-db/core<br/>Compartment → Collection → Crypto"]
        Composables --> Core
    end
    Core --> File["@noy-db/file<br/>(local)"]
    Core --> Dyn["@noy-db/dynamo<br/>(sync)"]
```

**Use case:** Regional accounting firm platform.
**Pros:** Reactive UI, type-safe, auto-sync, full offline support.
**Pinia integration (v0.3):** see [`ROADMAP.md#v03--pinia-first-dx--query--scale`](../ROADMAP.md#v03--pinia-first-dx--query--scale).

---

## 8. Development / testing

```bash
npm install @noy-db/core @noy-db/memory
```

```mermaid
flowchart LR
    Tests["Test suite<br/>createNoydb({ adapter: memory(), encrypt: false })"]
    Mem["@noy-db/memory"]
    Map[("In-memory Map<br/>(no I/O)")]
    Tests --> Mem --> Map
```

**Use case:** Unit tests, rapid prototyping, demos.
**Pros:** Zero setup, instant, deterministic. `encrypt: false` lets you inspect plaintext in tests.

---

## Mixing profiles

Adapters compose. For example, `withCache()` (v0.2+) turns any remote adapter into a cache-first adapter:

```ts
import { withCache } from '@noy-db/core';
import { browser } from '@noy-db/browser';
import { dynamo } from '@noy-db/dynamo';

const adapter = withCache(browser(), dynamo({ table: 'noydb-prod' }));
```

```mermaid
flowchart LR
    R["Read"] --> Cache{Cache hit?}
    Cache -->|yes| Done["return"]
    Cache -->|no| Remote["fetch remote"]
    Remote --> Populate["populate cache"]
    Populate --> Done

    W["Write"] --> Both["write cache + remote<br/>(cache-aside)"]
```

Custom compositions are easy: any function that takes adapters and returns an adapter is valid.
