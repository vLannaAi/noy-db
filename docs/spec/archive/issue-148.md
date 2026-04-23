# Issue #148 — refactor(stores): rename store-dynamo → store-aws-dynamo

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** _(none)_

---

## Summary

Rename `@noy-db/store-dynamo` to `@noy-db/store-aws-dynamo` for consistency with the explicit provider-prefix naming convention established by the v0.10 store architecture.

## Changes

- `packages/store-dynamo/` → `packages/store-aws-dynamo/`
- `package.json` name: `@noy-db/store-dynamo` → `@noy-db/store-aws-dynamo`
- Update all internal references and import paths
- Update `.github/CODEOWNERS`, CI workflows, playground, create-noy-db templates
- Bump to v0.10.0

## Rationale

DynamoDB is an AWS-only service. The `aws-` prefix makes the provider explicit and consistent with `@noy-db/store-aws-s3` (#149). No ambiguity, no duck-typing — this package is AWS SDK, AWS service, full stop.

## Related
- #149 — store-s3 → store-aws-s3 (companion rename)
