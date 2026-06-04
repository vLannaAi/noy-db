import { defineConfig } from 'tsup'
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  for (const item of readdirSync(src)) {
    const s = join(src, item)
    const d = join(dest, item)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

export default defineConfig({
  // Two entry points:
  //   - `src/index.ts` → `dist/index.js` — the module factory that Nuxt
  //     imports during `nuxt.config.ts` processing
  //   - `src/runtime/plugin.client.ts` → `dist/runtime/plugin.client.js`
  //     — the client-only runtime plugin that `createResolver().resolve()`
  //     points at. Nuxt loads it during app boot on the client side.
  //
  // Runtime files get their own output so the module's `resolver.resolve()`
  // path (`./runtime/plugin.client.js`) finds a real file on disk in the
  // published dist tree.
  entry: ['src/index.ts', 'src/runtime/plugin.client.ts', 'src/runtime/rest.ts'],
  // ESM-only: Nuxt 4 modules use `import.meta.url` which doesn't work
  // in CJS, and Nuxt itself is ESM-only as of v4. Shipping CJS would
  // be dead code that triggers a build warning.
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  // Mark Nuxt-internal modules as external so they're never bundled into
  // the module's dist. The consuming Nuxt project provides them.
  external: [
    '@nuxt/kit',
    '@nuxt/schema',
    'nuxt',
    'nuxt/app',
    '@noy-db/hub',
    '@noy-db/in-devtools',
    '@noy-db/in-pinia',
    '@noy-db/in-rest',
    '@noy-db/in-vue',
    'h3',
    'vue',
  ],
  async onSuccess() {
    copyDir('src/runtime/devtools', 'dist/runtime/devtools')
  },
})
