---
"@noy-db/create": minor
---

Add **augment mode** to the `create @noy-db` wizard — patch an existing Nuxt 4 project in-place instead of only creating new ones (closes #37).

Run the wizard from inside an existing Nuxt 4 project root:

```bash
cd ~/my-existing-nuxt-app
npm create @noy-db                    # preview + confirm
npm create @noy-db --dry-run          # print diff, don't write
npm create @noy-db --yes              # non-interactive
```

The wizard auto-detects existing Nuxt 4 projects by looking for **both** `nuxt.config.{ts,js,mjs}` and a `package.json` that lists `nuxt` in any dependency section. When both are present, it enters augment mode; otherwise it falls back to the classic fresh-project mode.

**What augment mode does** (via [magicast](https://github.com/unjs/magicast) AST rewriting):

1. Adds `'@noy-db/nuxt'` to the `modules` array (creating the array if missing)
2. Adds `noydb: { adapter, pinia: true, devtools: true }` (only if not already present)
3. Preserves unrelated config keys, comments, and formatting
4. Shows a colored unified diff before any write
5. Asks for confirmation (`y/n`) unless `--yes` is passed
6. Prints the install command for the `@noy-db/*` packages the config now depends on

**Safe behaviors**:

- **Idempotent**: re-running the wizard on an already-augmented project is a no-op.
- **Preserves custom config**: a pre-existing `noydb:` key is left untouched (only adds the module to `modules`).
- **`--dry-run`**: prints the diff without writing.
- **Unsupported shapes are rejected cleanly**: opaque exports, non-array `modules`, or malformed configs bail with a clear error message.
- **`--force-fresh` escape hatch**: forces the classic fresh-project path even when cwd looks like an existing Nuxt project.

**New option**: `dryRun`, `forceFresh` on `runWizard()`.

**New exports**: `detectNuxtProject`, `augmentNuxtConfig`, `writeAugmentedConfig`.

**Tests**: 19 new cases covering detect + augment + `runWizard` integration.

**Dependencies added**: `magicast@^0.3.5`, `diff@^7.0.0`.

Closes #37, part of v0.5.0.
