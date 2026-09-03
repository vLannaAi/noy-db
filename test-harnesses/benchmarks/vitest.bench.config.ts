/**
 * Benchmarks are measurements, not assertions: they live outside the CI
 * `*.test.ts` include (see `vitest.config.ts`) so a shared-runner timing
 * wobble can never fail a build. Run them on purpose, with
 * `pnpm --filter @noy-db/test-benchmarks bench:vectors`.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'test-benchmarks-bench',
    include: ['src/**/*.bench.ts'],
    environment: 'node',
  },
})
