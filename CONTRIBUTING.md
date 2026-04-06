# Contributing to noy-db

Thank you for your interest in contributing to noy-db!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/vLannaAi/noy-db.git
cd noy-db

# Install dependencies (requires pnpm)
pnpm install

# Build all packages
pnpm turbo build

# Run all tests
pnpm turbo test

# Lint
pnpm turbo lint

# Type check
pnpm turbo typecheck
```

## Project Structure

- `packages/` — Published npm packages (`@noy-db/*`)
- `test-harnesses/` — Private test infrastructure (never published)

## Adding a New Adapter

1. Create `packages/{name}/` following the existing adapter structure
2. Implement the `NoydbAdapter` interface (6 methods)
3. Import and run the conformance test suite:

```ts
// packages/{name}/__tests__/conformance.test.ts
import { runAdapterConformanceTests } from '@noy-db/test-adapter-conformance'
import { myAdapter } from '../src/index.js'

runAdapterConformanceTests('my-adapter', async () => myAdapter(/* opts */))
```

4. All 22 conformance tests must pass

## Pull Requests

- Create a changeset: `pnpm changeset`
- Ensure all checks pass: `pnpm turbo lint && pnpm turbo typecheck && pnpm turbo test`
- Keep PRs focused — one feature or fix per PR

## Crypto Rules

- All cryptography uses Web Crypto API (`crypto.subtle`) only
- Never add npm crypto dependencies
- Never reuse IVs — fresh 12-byte random IV per encrypt
- PBKDF2 iterations must stay at 600,000 minimum
- KEK must never be persisted to any storage
