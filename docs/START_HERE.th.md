# เริ่มต้นที่นี่ · Start here (ไทย)

> **เอกสารหน้าเดียว** สำหรับผู้เริ่มใช้งาน noy-db
> หากจะอ่าน noy-db สามฉบับ ให้อ่าน: ฉบับนี้, [`docs/topology-matrix.md`](./topology-matrix.md),
> แล้วตามด้วย [`SPEC.md`](../SPEC.md)
>
> 🇬🇧 Canonical English version: [`START_HERE.md`](./START_HERE.md)

> **หมายเหตุการแปล:** นี่เป็นการแปลฉบับแรก (first-pass) ผู้ใช้ที่พูดภาษาไทยเป็นภาษาแม่
> ยินดีรับคำแก้ไข — เปิด issue หรือ PR ได้

---

## noy-db คืออะไร ภายใน 60 วินาที

**ระบบเก็บเอกสารแบบเข้ารหัสที่ไม่รู้เนื้อหา (zero-knowledge), ทำงานแบบ offline ก่อน, และใช้งานได้กับ backend หลากหลายชนิด**

ติดตั้ง TypeScript library — เข้ารหัสทุก record ด้วย AES-256-GCM ก่อนส่งไปถึง backend
backend จะมองเห็นเพียงข้อมูลที่เข้ารหัสแล้ว — ไม่สามารถอ่านเนื้อหาได้

ข้อสัญญาสามข้อ:

- **ข้อมูลของคุณ เป็นของคุณ** — library เท่านั้นที่ถือกุญแจ backend อ่านไม่ได้
- **ทำงาน offline ได้** — ที่เก็บข้อมูลภายในเครื่องคือตัวหลัก การ sync เป็นทางเลือก
- **ใช้ backend อะไรก็ได้** — สลับระหว่างไฟล์, cloud, browser, USB ได้ในบรรทัดเดียว

---

## เลือก stack ใน 30 วินาที

ตอบสองคำถามตามลำดับ แล้วทำตามลูกศร

### คำถามที่ 1 — ข้อมูลอยู่ที่ไหน?

| คำตอบ | store หลักของคุณ |
|--------|--------------------|
| ในเบราว์เซอร์ (web app, PWA, Electron) | **`@noy-db/to-browser-idb`** |
| บน Node.js ในเครื่อง / server | **`@noy-db/to-file`** |
| บน cloud (เข้าถึงจากหลายอุปกรณ์) | **`@noy-db/to-aws-dynamo`** + **`@noy-db/to-aws-s3`** (blobs) |
| บน USB ที่พกพา | **`@noy-db/to-file`** ชี้ไปที่จุด mount |
| แค่ทดสอบหรือทดลอง | **`@noy-db/to-memory`** |

### คำถามที่ 2 — framework ไหนขับเคลื่อน UI?

| คำตอบ | integration ที่ใช้ |
|--------|------------------|
| Nuxt 4 | **`@noy-db/in-nuxt`** (รวม Pinia) |
| Vue 3 + Pinia | **`@noy-db/in-pinia`** |
| Vue 3 composables | **`@noy-db/in-vue`** |
| Yjs collaborative editing | **`@noy-db/in-yjs`** |
| React / Svelte / Solid / Qwik | วางแผน — ดู `Fork · Integrations` milestone |
| ไม่มี framework | เพียง `@noy-db/hub` (+ store) |

---

## Quick start (30 วินาที)

```bash
npm create noy-db@latest my-app
cd my-app
pnpm install
pnpm dev
```

template ที่พร้อมใช้งาน (v0.13):

- **`vanilla`** — Vite + TypeScript, ไม่มี framework  จุดเริ่มต้นที่เล็กที่สุด
- **`nuxt-default`** — Nuxt 4 + Pinia + IndexedDB  จุดเริ่มต้น full-stack แบบครบวงจร

---

## ชื่อเรียก package

| คำนำหน้า | ความหมาย | ตัวอย่าง |
|-----------|----------|----------|
| **`in-`** | integrate **เข้าไปใน** framework | `in-vue`, `in-pinia`, `in-nuxt`, `in-react` |
| **`to-`** | ข้อมูลไป **สู่** ที่เก็บ | `to-file`, `to-aws-dynamo`, `to-aws-s3` |
| **`on-`** | ขึ้น **ไปบน** ระบบ (authentication) | `on-webauthn`, `on-oidc`, `on-totp` |

---

## Feature inventory — มีอะไรใน v0.12

| หมวด | มี |
|------|-----------|
| **การเข้ารหัส** | AES-256-GCM · IV สุ่มต่อ record · PBKDF2-SHA256 600K iterations · AES-KW wrapping |
| **ที่เก็บ** | 6-method NoydbStore contract · `file`, `memory`, `browser-idb`, `browser-local`, `aws-dynamo`, `aws-s3` |
| **Query DSL** | Chainable builder (`where` / `orderBy` / `limit` / `join` / `groupBy` / `aggregate`) |
| **Joins** | Eager joins · multi-FK chaining · live (reactive) joins · streaming `scan().aggregate()` |
| **FK integrity** | `ref(target, { mode })` — strict / warn / cascade · `vault.checkIntegrity()` |
| **Blobs** | `collection.blob(id)` → `BlobSet` · versioning · HMAC eTags · MIME magic detection |
| **Sync** | `SyncTarget[]` · role `sync-peer` / `backup` / `archive` · 4 push modes + 3 pull modes |
| **Store routing** | `routeStore({ default, blobs, routes, age, vaultRoutes, overflow })` |
| **Middleware** | `wrapStore(store, withRetry, withCircuitBreaker, withCache, withHealthCheck, withMetrics, withLogging)` |
| **Session** | Session tokens · timeout · re-auth policies · magic-link |
| **Access control** | 5 roles (owner / admin / operator / viewer / client) · per-collection permissions |
| **Authentication (on-*)** | `@noy-db/on-webauthn` · `@noy-db/on-oidc` |
| **i18n** | `dictKey()` · `i18nText()` · รองรับ Unicode ไทยเป็น first-class |
| **Integrity** | Hash-chained ledger · `.noydb` bundle format · tamper detection |
| **Testing** | 853 hub tests + 58 showcases |

---

## อ่านต่อที่ไหน

| ต้องการ... | อ่าน |
|-----------|------|
| เลือก store / topology | [`docs/topology-matrix.md`](./topology-matrix.md) |
| เข้าใจการตัดสินใจออกแบบทุกข้อ | [`SPEC.md`](../SPEC.md) |
| เข้าใจ threat model | [`docs/architecture.md`](./architecture.md) |
| คัดลอก minimal setup | [`docs/getting-started.md`](./getting-started.md) |
| ดู feature ทุกตัวทำงาน end-to-end | [`showcases/`](../showcases/) — 14 ไฟล์ vitest |
| เชื่อมต่อ Google / Apple / LINE / Auth0 / Keycloak | [`docs/oidc-providers.md`](./oidc-providers.md) |
| มีส่วนร่วม | [`CLAUDE.md`](../CLAUDE.md) · [`ROADMAP.md`](../ROADMAP.md) |

---

## Showcases

| # | ไฟล์ | พิสูจน์อะไร |
|---|------|----------------|
| 01 | `01-accounting-day` | Pinia + reactive CRUD + aggregates |
| 02 | `02-multi-user-access` | Keyring rotation · revoked-user lockout |
| 03 | `03-store-routing` | `routeStore` + override / suspend / resume |
| 04 | `04-sync-two-offices` | Offline-first + multi-peer sync |
| 05 | `05-blob-lifecycle` | `BlobSet` — put/get/response/publish/versions |
| 06 | `06-cascade-delete-fk` | FK refs + `vault.checkIntegrity()` |
| 07 | `07-query-analytics` | Analytics 200 rows — groupBy / aggregate / top-N |
| 08 | `08-resilient-middleware` | `wrapStore` + retry + circuit breaker + metrics |
| 09 | `09-encrypted-crdt` | Yjs CRDT round-tripping ผ่าน AES-GCM |
| 10 | `10-cloud-dynamo` | AWS DynamoDB จริง (env-gated) |
| 11 | `11-aws-split-store` | Records ไป DynamoDB + blobs ไป S3 ด้วย `routeStore` |
| 12 | `12-oidc-bridge` | OIDC split-key passphrase-less unlock |
| 13 | `13-webauthn` | WebAuthn PRF + rawId-fallback passkey unlock |
| 14 | `14-dictionary-i18n` | Multi-locale (EN / TH / AR-RTL) ด้วย `dictKey` + `i18nText` |

ทุก showcase รันได้: `pnpm --filter @noy-db/showcases test`
