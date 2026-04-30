/**
 * Augment an existing Nuxt 4 project with `@noy-db/in-nuxt`.
 *
 * The entry point is `augmentNuxtConfig()`, which reads a
 * `nuxt.config.ts` (or `.js` / `.mjs`) via magicast, mutates the
 * AST to:
 *
 *   1. Add `'@noy-db/in-nuxt'` to the `modules` array (creating the
 *      array if it doesn't exist)
 *   2. Add the `noydb: { adapter, pinia: true, devtools: true }`
 *      config key (creating it if it doesn't exist)
 *
 * then generates the new source code, computes a unified diff
 * against the original, and either writes the result (with
 * optional user confirmation) or returns the diff unchanged for
 * `--dry-run`.
 *
 * ## Idempotency
 *
 * Re-running the wizard on an already-augmented project is a
 * no-op: we check whether the target values are already present
 * before mutating, and if both are, we short-circuit before
 * calling `generateCode()`. The caller sees
 * `{ changed: false, reason: 'already configured' }` and can
 * exit cleanly.
 *
 * ## Edge cases
 *
 * - `export default defineNuxtConfig({...})` — the common case,
 *   handled directly.
 * - `export default {...}` — plain object literal, also handled.
 * - `export default someVar` — opaque reference, we bail with a
 *   clear error telling the user to edit manually. We don't try
 *   to chase the variable.
 * - `modules` declared as an object instead of an array — rare
 *   but possible in some Nuxt tooling. We bail.
 * - `modules` already contains `'@noy-db/in-nuxt'` — idempotent skip.
 * - `noydb` key already present — we preserve the existing value
 *   UNLESS `force: true` is passed (not yet surfaced in the CLI;
 *   reserved for a future `--overwrite-config` flag).
 *
 * ## Why magicast instead of a regex/string-patch
 *
 * Regex-based config patching produces correct-looking code 90%
 * of the time and silently wrong code the other 10%. Anything
 * non-trivial (nested options, comments, multi-line strings,
 * conditional exports) breaks. Magicast walks a real Babel AST,
 * preserves unrelated formatting, and round-trips the file
 * cleanly — including comments, trailing commas, and property
 * order.
 */

import { promises as fs } from 'node:fs'
import { loadFile, generateCode, builders } from 'magicast'
import { createPatch } from 'diff'
import type { WizardAdapter } from './types.js'

export interface AugmentOptions {
  /** Absolute path of the nuxt.config.{ts,js,mjs} to patch. */
  configPath: string
  /** Adapter string to write into `noydb: { adapter }`. */
  adapter: WizardAdapter
  /**
   * When true, skip the write and return the would-be result.
   * The CLI's `--dry-run` flag threads through to here.
   */
  dryRun?: boolean
}

export type AugmentResult =
  | {
      readonly kind: 'already-configured'
      readonly configPath: string
      readonly reason: string
    }
  | {
      readonly kind: 'proposed-change'
      readonly configPath: string
      readonly originalCode: string
      readonly newCode: string
      /** Unified diff string suitable for printing to the terminal. */
      readonly diff: string
      /** `true` when `options.dryRun` was set — the caller skips the write. */
      readonly dryRun: boolean
    }
  | {
      readonly kind: 'unsupported-shape'
      readonly configPath: string
      readonly reason: string
    }

/**
 * Parse, mutate, and compute the diff. Does NOT write the file —
 * that's the caller's responsibility, after (optionally) prompting
 * the user for confirmation.
 *
 * The split exists so the CLI can interleave the prompt between
 * "show the diff" and "write the file", and so tests can inspect
 * the proposed change without any filesystem side effect beyond
 * the initial read.
 */
export async function augmentNuxtConfig(
  options: AugmentOptions,
): Promise<AugmentResult> {
  const originalCode = await fs.readFile(options.configPath, 'utf8')
  const mod = await loadFile(options.configPath)

  // The entry point is whatever `export default` points at. In a
  // Nuxt config this is either `defineNuxtConfig({...})` or a
  // plain object literal.
  const exported = mod.exports.default as unknown
  if (exported === undefined || exported === null) {
    return {
      kind: 'unsupported-shape',
      configPath: options.configPath,
      reason: `${options.configPath} has no default export. Expected \`export default defineNuxtConfig({...})\` or \`export default {...}\`.`,
    }
  }

  // Both the `defineNuxtConfig({...})` call and the plain-object
  // case expose the config as a proxified object. For the function
  // call, magicast's proxy makes `exported.$args[0]` the config
  // object; for a plain object it's `exported` itself. We test
  // both shapes and pick the first one that has `modules` or can
  // accept a `modules` write.
  //
  // This looks a bit like JavaScript duck-typing because it IS
  // duck-typing — magicast's proxy tolerates either shape and the
  // API surface is identical once you reach the config object.
  const config = resolveConfigObject(exported)
  if (!config) {
    return {
      kind: 'unsupported-shape',
      configPath: options.configPath,
      reason: `Could not find the config object in ${options.configPath}. ` +
        `Expected \`export default defineNuxtConfig({ modules: [], ... })\` or a plain object literal.`,
    }
  }

  const skipReasons: string[] = []

  // --- Modules array -------------------------------------------------
  // Ensure `modules` is an array; create it if missing. Magicast's
  // proxy handles the array-vs-missing distinction via typeof checks
  // on the array's length property.
  const modulesRaw: unknown = config.modules
  let modulesWasMissing = false
  if (modulesRaw === undefined) {
    modulesWasMissing = true
    config.modules = []
  } else if (typeof modulesRaw !== 'object' || !isProxyArray(modulesRaw)) {
    return {
      kind: 'unsupported-shape',
      configPath: options.configPath,
      reason: `\`modules\` in ${options.configPath} is not an array literal. ` +
        `Edit it manually and re-run the wizard if you want to continue.`,
    }
  }

  // Push '@noy-db/in-nuxt' if it's not already listed. We compare by
  // stringification because magicast's proxy yields primitive
  // strings for literal entries.
  const modules = config.modules as string[]
  const alreadyHasModule = Array.from(modules).some((m) => String(m) === '@noy-db/in-nuxt')
  if (alreadyHasModule) {
    skipReasons.push('`@noy-db/in-nuxt` already in modules')
  } else {
    // Insert as a literal string so magicast writes `'@noy-db/in-nuxt'`
    // rather than an object wrapper.
    modules.push('@noy-db/in-nuxt')
  }

  // --- `noydb` config key --------------------------------------------
  // If the user already has a noydb key, preserve it — they might
  // have custom options we don't want to clobber. If it doesn't
  // exist, add it with the adapter the wizard collected.
  const noydbRaw: unknown = config.noydb
  if (noydbRaw !== undefined) {
    skipReasons.push('`noydb` key already set')
  } else {
    // `builders.raw` parses the literal into an AST node, so the
    // output is a real object expression in the generated code
    // instead of a stringified opaque blob.
    config.noydb = builders.raw(
      `{ adapter: '${options.adapter}', pinia: true, devtools: true }`,
    )
  }

  // If nothing changed, short-circuit. `modulesWasMissing` is a
  // change even if we didn't push anything, because we wrote an
  // empty array into the config — but that's an unusual case so
  // we lump it in with the regular "changed" path.
  if (skipReasons.length === 2 && !modulesWasMissing) {
    return {
      kind: 'already-configured',
      configPath: options.configPath,
      reason: skipReasons.join('; '),
    }
  }

  // Generate the new source, then compute a unified diff against
  // the original. `createPatch` is from the `diff` package — same
  // one `jest-diff` and `vitest` use under the hood. The empty
  // header strings keep the diff output compact for terminal
  // display; a full unified diff header isn't needed since we're
  // going to print the diff inline, not pipe it to `patch -p1`.
  const generated = generateCode(mod).code
  const diff = createPatch(
    options.configPath,
    originalCode,
    generated,
    '',
    '',
    { context: 3 },
  )

  return {
    kind: 'proposed-change',
    configPath: options.configPath,
    originalCode,
    newCode: generated,
    diff,
    dryRun: options.dryRun === true,
  }
}

/**
 * Write the augmented config to disk. Call this after the user
 * has seen and approved the diff from `augmentNuxtConfig()`. The
 * split between "compute" and "write" is deliberate — see the
 * module docstring.
 */
export async function writeAugmentedConfig(
  configPath: string,
  newCode: string,
): Promise<void> {
  await fs.writeFile(configPath, newCode, 'utf8')
}

// ─── Internal helpers ─────────────────────────────────────────────────

/**
 * Given the proxified default export, return the config object
 * itself. Handles both `defineNuxtConfig({...})` (proxified function
 * call whose `$args[0]` is the config) and `{...}` (plain object
 * proxy). Returns null for shapes we don't recognize.
 *
 * Important: magicast's `$args` is a PROXY, not a real array, so
 * `Array.isArray($args)` returns false. We access `$args[0]`
 * directly and check whether the result is a usable object.
 */
function resolveConfigObject(
  exported: unknown,
): Record<string, unknown> | null {
  if (!exported || typeof exported !== 'object') return null
  const proxy = exported as Record<string, unknown> & {
    $type?: string
    $args?: Record<number, unknown>
  }

  // defineNuxtConfig(...) call — magicast exposes the args through
  // a proxied $args accessor. The config literal is at $args[0].
  if (proxy.$type === 'function-call' && proxy.$args) {
    const firstArg = proxy.$args[0]
    if (firstArg && typeof firstArg === 'object') {
      return firstArg as Record<string, unknown>
    }
    return null
  }

  // Plain object literal export — the proxy IS the config.
  if (proxy.$type === 'object' || proxy.$type === undefined) {
    return proxy
  }

  return null
}

/**
 * Check whether a magicast-proxied value is an array. The proxy
 * reports `$type === 'array'` for array literals; plain objects
 * and strings come back with different tags.
 */
function isProxyArray(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const proxy = value as { $type?: string }
  return proxy.$type === 'array'
}
