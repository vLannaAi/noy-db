# Issue #175 — Showcase 10: Cloud DynamoDB (Nuxt)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 10-cloud-dynamo.showcase.ts — "Cloud DynamoDB"

**Framework:** Nuxt composables (no Pinia) | **Store:** `dynamo(...)` (real AWS) | **Branch:** `showcase/10-cloud-dynamo`
**Skipped by default:** Runs only when `NOYDB_SHOWCASE_DYNAMO=1` env var is set

### Prerequisites
```bash
aws cloudformation deploy --template-file showcases/cfn-showcase-table.yaml --stack-name noydb-showcase
```

### Flow
- `createNoydb({ store: dynamo({ table: 'noydb-showcase' }) })`
- `useCollection(db, vault, 'invoices')` — write, read, verify reactivity
- Push/pull sync (memory ↔ DynamoDB)
- Cleanup: delete test records

### Cleanup
```bash
aws cloudformation delete-stack --stack-name noydb-showcase
```

**Goal:** Real cloud deployment with Nuxt composables — no mocks, no Docker.
**Dimension:** Cloud, real AWS, Nuxt composables
