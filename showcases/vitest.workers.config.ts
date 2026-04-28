/**
 * Separate vitest config for showcase 63, which runs inside Cloudflare's
 * workerd runtime via `@cloudflare/vitest-pool-workers`. The default
 * config (vitest.config.ts) uses happy-dom and runs the other 60
 * showcases under Node — leaving them untouched here.
 *
 * Run with: `pnpm test:workers`. Don't run with the default `pnpm test`,
 * or vitest will try to load the workerd-only test through happy-dom and
 * fail on `cloudflare:test` imports.
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
    include: ['src/**/*.workers.test.ts'],
    testTimeout: 30_000,
  },
})
