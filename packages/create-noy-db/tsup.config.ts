import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entry points:
  //   - `src/index.ts` → public API surface (exported wizard + commands so
  //     they can be re-used programmatically and tested cleanly)
  //   - `src/bin/create-noy-db.ts` → the `create-noy-db` bin (wizard for
  //     fresh projects, invoked by `npm create noy-db@latest`)
  //   - `src/bin/noy-db.ts` → the `noy-db` bin (subcommand dispatcher for
  //     ongoing project commands like `add` and `verify`)
  //
  // Each bin gets its own output file with a shebang so it can be invoked
  // directly. tsup adds the shebang automatically when it sees one in the
  // entry source file.
  entry: [
    'src/index.ts',
    'src/bin/create-noy-db.ts',
    'src/bin/noy-db.ts',
  ],
  // ESM-only: every other @noy-db package is ESM and Node 20+ supports it
  // natively. CJS would just be dead code that bloats the install.
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  // External: @clack/prompts and picocolors are runtime deps; we don't bundle
  // them. @noy-db/core and @noy-db/memory are devDependencies used only by
  // the integrity check (verify command), and we want them resolved from the
  // user's project (or from create-noy-db's own node_modules at install time).
  external: [
    '@clack/prompts',
    'picocolors',
    '@noy-db/core',
    '@noy-db/memory',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:url',
    'node:process',
    'node:child_process',
  ],
})
