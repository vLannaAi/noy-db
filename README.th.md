<div align="center">

<img alt="noy-db logo" src="docs/assets/brand.svg" width="180">

# noy-db

## None Of Your DataBase

**ข้อมูลของคุณ · อุปกรณ์ของคุณ · กุญแจของคุณ · ไม่มี server ของใครอื่น**

ระบบเก็บเอกสารแบบเข้ารหัส, offline-first, และ **serverless**
library อยู่ภายในแอปของคุณ, เก็บข้อมูลใน backend ที่คุณเลือก,
และไม่มีใครระหว่างกลางเห็นเนื้อหาได้ — ไม่ใช่ cloud provider, ไม่ใช่ sysadmin,
ไม่ใช่ database vendor และแม้แต่ noy-db เองก็ไม่เห็น

🇬🇧 Canonical English: [`README.md`](./README.md)

</div>

---

> **หมายเหตุการแปล:** นี่เป็นการแปลฉบับแรก (first-pass) ผู้พูดภาษาไทยเป็นภาษาแม่
> ยินดีรับคำแก้ไข — เปิด issue หรือ PR ได้

---

## ทำไมต้องมี noy-db

เครื่องมือเก็บข้อมูลส่วนใหญ่สันนิษฐานว่าคุณจะเช่า database จากใครสักคน
noy-db สันนิษฐานตรงข้าม: **ข้อมูลของคุณอยู่บนอุปกรณ์ของคุณ** ไม่ใช่ใน cloud ของใคร

ทุกการตัดสินใจในการออกแบบ project นี้ สร้างขึ้นรอบแนวคิดนี้
ค่า default คือ **offline** ขอบเขตความไว้ใจเริ่มต้นคือ **process ของคุณ**
backend เริ่มต้นคือ **ไฟล์ที่คุณควบคุม** Sync, multi-user, cloud storage — เป็น
capability เพิ่มที่คุณเลือกใช้เมื่อจำเป็น ไม่ใช่ข้อสันนิษฐานพื้นฐานที่คุณหนีไม่ได้

หาก cloud provider ของคุณถูกเจาะ attacker ได้เพียง ciphertext
sysadmin อ่าน DynamoDB table ก็เห็นแค่ ciphertext คุณทำ USB stick หาย ใครเจอก็เห็นแค่
ciphertext การเข้ารหัสเกิดขึ้นก่อนที่ข้อมูลจะออกจาก library

**ความเป็นเจ้าของข้อมูลไม่ใช่ feature ที่เราชิปเพิ่ม — มันคือรูปร่างของ project ทั้งหมด**

---

## Hard privacy คือเป้าหมาย

ในวิศวกรรมความเป็นส่วนตัว มีการแยกที่ควรเรียกให้ชัด:

- **Soft privacy** คือคำสัญญา ผู้ให้บริการบอกว่าจะปกป้องข้อมูลของคุณ — ด้วย policy,
  ด้วยการฝึกพนักงาน ด้วย certificate compliance คุณต้องไว้ใจ policy, ไว้ใจคน, ไว้ใจเจ้าของในอนาคต,
  ไว้ใจเขตอำนาจศาล, ไว้ใจการตอบสนองต่อหมายศาล, ไว้ใจทีมรับมือเหตุการณ์ในวันที่แย่ที่สุด
- **Hard privacy** ขจัดความจำเป็นในการไว้ใจนั้น ไม่มีใคร *อื่น* ทำลายคำสัญญาได้ เพราะไม่มีใครอื่นอยู่ในตำแหน่งที่จะทำได้
  พวกเขาไม่มีกุญแจ และไม่เคยมีกุญแจ

noy-db เป็นเครื่องมือ hard-privacy ผู้เดียวที่อ่าน record ได้ คือผู้ถือ passphrase

---

## คุณสมบัติหลัก

- **🔒 Zero-knowledge encryption** — AES-256-GCM ด้วย per-user keys ทุก adapter (file, DynamoDB, S3, browser storage)
  เห็นแค่ ciphertext ทำ USB stick หาย, cloud ถูกเจาะ, provider ได้รับหมายศาล — ไม่มีใครอ่าน record ได้
- **☁️ Serverless by design** — **ไม่มี server ของ noy-db ให้ต้องรัน** ไม่มี Docker, ไม่มี managed service,
  ไม่มี backend ที่ต้องดูแล library เป็น TypeScript package ขนาด ~30 KB ที่ฝังในแอปของคุณ
- **📱 ทำงานบน OS ไหน, อุปกรณ์ไหนก็ได้** — macOS, Linux, Windows, iOS, Android, Raspberry Pi, laptop เก่า, tab ใน browser
  ต้องการเพียง JavaScript runtime + Web Crypto API — เท่านั้น
- **🌐 Offline-first** — ทุก operation ทำงานได้โดยไม่มีอินเทอร์เน็ต Sync ไป remote เป็น opportunistic
- **👥 Multi-user ในตัว** — 5 roles (owner / admin / operator / viewer / client) · per-collection permissions ·
  portable keyrings · key rotation เมื่อ revoke
- **📎 Encrypted blob store** — ไฟล์ binary (PDF, ภาพ, สแกน) เคียงข้าง records · content-addressed · deduplicated · versioned
- **🔀 Store routing** — `routeStore()` ส่ง records ไป DynamoDB และ blobs ไป S3 ในการเรียก `createNoydb()` เดียว
- **🧱 Store middleware** — `wrapStore(store, withRetry(), withCache(), withCircuitBreaker(), withHealthCheck())`

---

## ทำงานบนอะไรก็ได้ที่คุณมี

| Platform | Runtime | Storage backend | Status |
|---|---|---|---|
| 🖥️ **Desktop** — macOS / Linux / Windows | Node 18+, Bun, Deno | `@noy-db/to-file` (JSON on disk) | ✅ |
| 📱 **Mobile browser** — iOS Safari 14+, Android Chrome 90+ | Browser JS | `@noy-db/to-browser-idb` | ✅ |
| 🌐 **Desktop browser** — Chrome, Firefox, Safari, Edge | Browser JS | `@noy-db/to-browser-idb` | ✅ |
| ⚡ **PWA / offline web app** | Service Worker + browser | `@noy-db/to-browser-idb` | ✅ |
| 🖧 **Server (headless)** | Node 18+ | `@noy-db/to-file`, `@noy-db/to-aws-dynamo`, `@noy-db/to-aws-s3` | ✅ |
| 💾 **USB stick / removable disk** | OS ใดก็ได้ + runtime ใดก็ได้ | `@noy-db/to-file` | ✅ |
| 🔌 **Electron / Tauri desktop app** | Desktop shell | `@noy-db/to-file` หรือ `@noy-db/to-browser-idb` | ✅ |
| 🧪 **Testing / CI** | JavaScript runtime ใดก็ได้ | `@noy-db/to-memory` (no persistence) | ✅ |

---

## International project, โฟกัสประเทศไทย

noy-db เป็น open-source project นานาชาติ พัฒนาและดูแลจาก **ประเทศไทย** consumer production แรก
คือสำนักงานบัญชีในภาคเหนือ — ข้อสันนิษฐานในการออกแบบ library (offline-first, multi-user,
ข้อมูลการเงินที่ sensitive, per-tenant isolation, USB-based workflow สำหรับการเชื่อมต่อที่ไม่ดี)
มาจากการ deploy ที่นั่นโดยตรง

การรองรับภาษาไทยและรูปแบบภูมิภาคเป็น first-class ไม่ใช่สิ่งที่คิดทีหลัง:

- **การจัดการข้อความไทย** — Unicode ทุกที่ · Record IDs, field values, user display names, error messages,
  และ backup files ทั้งหมด round-trip ตัวอักษรไทยได้อย่างสะอาด
- **รูปแบบภูมิภาค** — Buddhist Era dates (`พ.ศ. 2568`), เลขไทย (`๐ ๑ ๒ ๓`), การจัดรูปแบบสกุลเงิน THB
  ผ่าน `Intl` API มาตรฐาน
- **Thai prompts ใน scaffolder** — wizard `npm create @noy-db` จะชิปทั้งภาษาอังกฤษและไทย
  auto-detect จาก `LANG` / `LC_ALL`
- **Timezones** — ISO-8601 พร้อม offset ชัดเจนทุกที่

ผู้ร่วมพัฒนาและผู้ใช้นานาชาติยินดีต้อนรับ เปิด issue หรือ PR ด้วยภาษาที่คุณสะดวก — อังกฤษ, ไทย,
หรือภาษาอื่น — และเราจะทำงานกับมันได้

---

## เริ่มใช้งาน — Nuxt 4 + Pinia (สองนาที)

Happy path คือ config block เดียว + store file เดียว + component เดียว ทุกอย่างด้านล่างถูกเข้ารหัสด้วย
AES-256-GCM ก่อนถึง localStorage / IndexedDB

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@pinia/nuxt', '@noy-db/in-nuxt'],
  noydb: {
    adapter: 'browser',
    pinia: true,
    devtools: true,
  },
})
```

```ts
// app/stores/invoices.ts — defineNoydbStore ถูก auto-import
export interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid'
}

export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
```

```vue
<!-- app/pages/invoices.vue -->
<script setup lang="ts">
const invoices = useInvoices()
await invoices.$ready

const drafts = invoices.query()
  .where('status', '==', 'draft')
  .live()
</script>

<template>
  <ul>
    <li v-for="inv in drafts" :key="inv.id">
      {{ inv.client }} — {{ inv.amount }}
    </li>
  </ul>
</template>
```

นั่นคือแอปทั้งหมด · Reactive Pinia store, encrypted storage, SSR-safe

---

## Documentation

- 🚀 [เริ่มต้นที่นี่ (ไทย)](./docs/guides/START_HERE.th.md) — จุดเข้าหลัก
- 🧭 [Topology matrix](./docs/guides/topology-matrix.md) — เลือก store / pattern
- 📐 [Architecture](./docs/reference/architecture.md) — data flow + threat model
- 📋 [SPEC](./SPEC.md) — design invariants
- 🗺️ [ROADMAP](./ROADMAP.md) — trunk + forks + timeline

---

<div align="center">
  <sub>ข้อมูลของคุณ · อุปกรณ์ของคุณ · กุญแจของคุณ · <b>None Of Your DataBase</b></sub>
</div>
