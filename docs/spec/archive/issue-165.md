# Issue #165 — Showcase scaffold: package.json, vitest config, CFN template

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## Scaffold the `/showcases/` directory

### Files to create
- `showcases/package.json` — workspace package with hub + store + framework deps
- `showcases/vitest.config.ts` — standalone vitest config (happy-dom for Vue/Pinia tests)
- `showcases/tsconfig.json` — extends root, ESM
- `showcases/cfn-showcase-table.yaml` — CloudFormation template for ephemeral DynamoDB table
- `showcases/README.md` — what showcases are, how to run, framework matrix, CFN commands

### Branch
`showcase/scaffold`

### Acceptance
- `pnpm install` succeeds with new workspace package
- `pnpm vitest run` in showcases/ runs (even if no tests yet)
- CFN template validates
