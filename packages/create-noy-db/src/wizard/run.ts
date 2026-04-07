/**
 * The wizard entry point — `runWizard()`.
 *
 * Two modes:
 *
 *   1. **Interactive (default).** Uses `@clack/prompts` to ask the user
 *      for project name, adapter, and sample-data inclusion. Cancellation
 *      at any prompt aborts cleanly with a non-zero exit code.
 *
 *   2. **Non-interactive (`yes: true`).** Skips every prompt and uses the
 *      values supplied in `WizardOptions`. Missing values become defaults.
 *      This is the path tests take — no terminal needed, fully scriptable.
 *
 * The function never spawns child processes (no `npm install` etc.). It
 * only writes files and returns. The shell wrapper around `npm create` is
 * responsible for installing — we keep this layer pure so it's trivially
 * testable and so adding a `--no-install` flag later is a no-op.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { renderTemplate, templateDir, type RenderTokens } from './render.js'
import type {
  WizardAdapter,
  WizardOptions,
  WizardResult,
  WizardFreshResult,
  WizardAugmentResult,
} from './types.js'
import { detectNuxtProject } from './detect.js'
import { augmentNuxtConfig, writeAugmentedConfig } from './augment.js'

/**
 * Default invoice records the wizard injects when `sampleData: true`.
 * Kept here (not in the template) so the same records can be reused by
 * the `noy-db add` command for collections with `--seed`. Three records
 * is enough to demo a query that returns more than one row.
 */
const DEFAULT_SEED = [
  {
    id: 'inv-001',
    client: 'Acme Holdings',
    amount: 1500,
    status: 'open',
    dueDate: '2026-05-01',
  },
  {
    id: 'inv-002',
    client: 'Globex Inc',
    amount: 4200,
    status: 'paid',
    dueDate: '2026-04-15',
  },
  {
    id: 'inv-003',
    client: 'Initech LLC',
    amount: 850,
    status: 'overdue',
    dueDate: '2026-03-20',
  },
]

const ADAPTER_LABELS: Record<WizardAdapter, string> = {
  browser: 'browser — localStorage / IndexedDB (recommended for web apps)',
  file: 'file — JSON files on disk (Electron / Tauri / USB workflows)',
  memory: 'memory — no persistence (ideal for tests and demos)',
}

/**
 * Validates the project name. Rules are intentionally narrow:
 * - non-empty
 * - lowercase letters, digits, hyphens, dots, underscores only
 * - cannot start with a hyphen, dot, or underscore
 * - max 214 chars (npm package-name limit)
 *
 * The narrow rule set means whatever the user types is also a valid npm
 * package name, so the generated `package.json#name` field is always safe.
 */
export function validateProjectName(name: string): string | null {
  if (!name || name.trim() === '') return 'Project name cannot be empty'
  if (name.length > 214) return 'Project name must be 214 characters or fewer'
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return 'Project name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, dots, or underscores'
  }
  return null
}

/**
 * Main entry point. Detects whether `cwd` is an existing Nuxt 4
 * project and routes to one of two modes:
 *
 *   - **Fresh mode** (the original v0.3.1 behavior): prompts for
 *     project name, creates a new directory, renders the Nuxt 4
 *     starter template. Returns a `WizardFreshResult`.
 *
 *   - **Augment mode** (new in v0.5, #37): patches the existing
 *     `nuxt.config.ts` via magicast to add `@noy-db/nuxt` to the
 *     modules array and a `noydb:` config key. Shows a unified
 *     diff and asks for confirmation before writing. Supports
 *     `--dry-run`. Returns a `WizardAugmentResult`.
 *
 * The auto-detection rule: if cwd has both a `nuxt.config.ts`
 * (or `.js`/`.mjs`) AND a `package.json` that lists `nuxt` in any
 * dependency section, augment mode fires. Otherwise fresh mode.
 * Users can force fresh mode via `forceFresh: true` (CLI:
 * `--force-fresh`) when they want to create a sub-project inside
 * an existing Nuxt workspace.
 *
 * Both modes refuse to clobber existing work: fresh mode rejects
 * non-empty target dirs; augment mode rejects unsupported config
 * shapes (opaque exports, non-array modules, etc.).
 */
export async function runWizard(options: WizardOptions = {}): Promise<WizardResult> {
  const cwd = options.cwd ?? process.cwd()
  const yes = options.yes ?? false

  // ── Detect existing Nuxt project ───────────────────────────────────
  // Runs BEFORE any prompts so the interactive flow branches cleanly
  // into fresh vs augment without asking the user questions that
  // don't apply to their mode. `forceFresh` short-circuits the
  // detection — CI tests use this to scaffold into a temp dir that
  // happens to sit under an existing Nuxt project.
  const detection = options.forceFresh
    ? null
    : await detectNuxtProject(cwd)

  if (detection?.existing && detection.configPath) {
    return runAugmentMode(options, cwd, detection.configPath)
  }

  return runFreshMode(options, cwd, yes)
}

/**
 * The original v0.3.1 fresh-project path, factored out of the
 * main entry so the augment branch above can coexist. Behavior
 * is unchanged from v0.3.1 except the return shape now includes
 * the `kind: 'fresh'` discriminator.
 */
async function runFreshMode(
  options: WizardOptions,
  cwd: string,
  yes: boolean,
): Promise<WizardFreshResult> {
  // ── Resolve answers ────────────────────────────────────────────────
  // In non-interactive mode every prompt is short-circuited; in
  // interactive mode we only prompt for fields the caller didn't supply.
  const projectName = yes
    ? options.projectName ?? 'my-noy-db-app'
    : await promptProjectName(options.projectName)

  const adapter: WizardAdapter = yes
    ? options.adapter ?? 'browser'
    : await promptAdapter(options.adapter)

  const sampleData: boolean = yes
    ? options.sampleData ?? true
    : await promptSampleData(options.sampleData)

  // ── Validate target directory ──────────────────────────────────────
  // We refuse to write into a non-empty directory. Empty + missing are
  // both fine — fs.mkdir { recursive: true } handles both. The `Cancelled`
  // exit is intentional: cleaner than throwing an Error from a wizard.
  const projectPath = path.resolve(cwd, projectName)
  await assertWritableTarget(projectPath)

  // ── Render the template ────────────────────────────────────────────
  const tokens: RenderTokens = {
    PROJECT_NAME: projectName,
    ADAPTER: adapter,
    DEVTOOLS: 'true',
    SEED_INVOICES: sampleData
      ? JSON.stringify(DEFAULT_SEED, null, 2).replace(/\n/g, '\n  ')
      : '[]',
  }

  await fs.mkdir(projectPath, { recursive: true })
  const files = await renderTemplate(
    templateDir('nuxt-default'),
    projectPath,
    tokens,
  )

  if (!yes) {
    // Print a friendly summary so the user knows what happened. We don't
    // run `npm install` ourselves — the user picks the package manager.
    p.note(
      [
        `${pc.bold('cd')} ${projectName}`,
        `${pc.bold('pnpm install')}     ${pc.dim('(or npm/yarn/bun)')}`,
        `${pc.bold('pnpm dev')}`,
      ].join('\n'),
      'Next steps',
    )
    p.outro(pc.green('✔ Done — happy encrypting!'))
  }

  return {
    kind: 'fresh',
    options: {
      projectName,
      adapter,
      sampleData,
      cwd,
    },
    projectPath,
    files,
  }
}

/**
 * The new v0.5 augment-existing-project path (#37). Runs magicast
 * on the detected nuxt.config, shows a unified diff, asks for
 * confirmation, and writes. Supports `--dry-run` to see the diff
 * without touching disk.
 *
 * Three outcomes:
 *   - **written**: the file was patched successfully
 *   - **already-configured**: both target mutations are already
 *     present (idempotent no-op)
 *   - **cancelled**: user said no at the confirmation prompt
 *   - **dry-run**: `options.dryRun` was set, we showed the diff
 *     and returned without writing
 *   - **unsupported-shape**: the config file uses a shape we can't
 *     safely mutate (opaque export, non-array modules, etc.)
 */
async function runAugmentMode(
  options: WizardOptions,
  cwd: string,
  configPath: string,
): Promise<WizardAugmentResult> {
  const yes = options.yes ?? false
  const dryRun = options.dryRun ?? false

  if (!yes) {
    p.note(
      [
        `${pc.dim('Detected existing Nuxt 4 project:')}`,
        `  ${pc.cyan(configPath)}`,
        '',
        'The wizard will add @noy-db/nuxt to your modules array',
        'and a noydb: config key. You can review the diff before',
        'anything is written to disk.',
      ].join('\n'),
      'Augment mode',
    )
  }

  // In augment mode we only need ONE prompt from the user: which
  // adapter to wire into the `noydb: { adapter }` key. Everything
  // else is decided by the config we're patching.
  const adapter: WizardAdapter = yes
    ? options.adapter ?? 'browser'
    : await promptAdapter(options.adapter)

  const result = await augmentNuxtConfig({
    configPath,
    adapter,
    dryRun,
  })

  if (result.kind === 'already-configured') {
    if (!yes) {
      p.note(
        `${pc.yellow('Nothing to do:')} ${result.reason}`,
        'Already configured',
      )
      p.outro(pc.green('✔ Your Nuxt config is already wired up.'))
    }
    return {
      kind: 'augment',
      configPath,
      adapter,
      changed: false,
      reason: 'already-configured',
    }
  }

  if (result.kind === 'unsupported-shape') {
    if (!yes) {
      p.cancel(`${pc.red('Cannot safely patch this config:')} ${result.reason}`)
    }
    return {
      kind: 'augment',
      configPath,
      adapter,
      changed: false,
      reason: 'unsupported-shape',
    }
  }

  // result.kind === 'proposed-change' — print the diff and either
  // write (after confirmation) or bail in dry-run mode.
  if (!yes || dryRun) {
    p.note(renderDiff(result.diff), 'Proposed changes')
  }

  if (dryRun) {
    if (!yes) p.outro(pc.green('✔ Dry run — no files were modified.'))
    return {
      kind: 'augment',
      configPath,
      adapter,
      changed: false,
      reason: 'dry-run',
      diff: result.diff,
    }
  }

  let shouldWrite = yes
  if (!yes) {
    const confirmed = await p.confirm({
      message: 'Apply these changes?',
      initialValue: true,
    })
    if (p.isCancel(confirmed) || confirmed !== true) {
      p.cancel('Aborted — your config is unchanged.')
      return {
        kind: 'augment',
        configPath,
        adapter,
        changed: false,
        reason: 'cancelled',
        diff: result.diff,
      }
    }
    shouldWrite = true
  }

  if (shouldWrite) {
    await writeAugmentedConfig(configPath, result.newCode)
    if (!yes) {
      p.note(
        [
          pc.dim('Install the @noy-db packages your config now depends on:'),
          '',
          `${pc.bold('pnpm add')} @noy-db/nuxt @noy-db/pinia @noy-db/core @noy-db/browser @pinia/nuxt pinia`,
          pc.dim('(or use npm/yarn/bun as appropriate)'),
        ].join('\n'),
        'Next step',
      )
      p.outro(pc.green('✔ Config updated — happy encrypting!'))
    }
  }

  return {
    kind: 'augment',
    configPath,
    adapter,
    changed: true,
    reason: 'written',
    diff: result.diff,
  }
}

/**
 * Clean up a unified diff for terminal display. Strips the `===`
 * separators the `diff` package emits, keeps a reasonable max
 * width, and drops the Index/------ preamble that's only useful
 * for `patch -p1`. The result is a short, colorized-ready string
 * that fits inside a clack `note()` block.
 */
function renderDiff(diff: string): string {
  const lines = diff.split('\n')
  const keep: string[] = []
  for (const line of lines) {
    if (line.startsWith('Index:')) continue
    if (line.startsWith('=')) continue
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('+')) keep.push(pc.green(line))
    else if (line.startsWith('-')) keep.push(pc.red(line))
    else if (line.startsWith('@@')) keep.push(pc.dim(line))
    else keep.push(line)
  }
  return keep.join('\n').trim()
}

// ─── Prompt helpers ──────────────────────────────────────────────────────

async function promptProjectName(initial?: string): Promise<string> {
  if (initial) {
    const err = validateProjectName(initial)
    if (err) throw new Error(err)
    return initial
  }
  const result = await p.text({
    message: 'Project name',
    placeholder: 'my-noy-db-app',
    initialValue: 'my-noy-db-app',
    validate: (v) => validateProjectName(v ?? '') ?? undefined,
  })
  if (p.isCancel(result)) {
    p.cancel('Cancelled.')
    process.exit(1)
  }
  return result
}

async function promptAdapter(initial?: WizardAdapter): Promise<WizardAdapter> {
  if (initial) return initial
  const result = await p.select<WizardAdapter>({
    message: 'Storage adapter',
    options: (['browser', 'file', 'memory'] as const).map((value) => ({
      value,
      label: ADAPTER_LABELS[value],
    })),
    initialValue: 'browser',
  })
  if (p.isCancel(result)) {
    p.cancel('Cancelled.')
    process.exit(1)
  }
  return result
}

async function promptSampleData(initial?: boolean): Promise<boolean> {
  if (typeof initial === 'boolean') return initial
  const result = await p.confirm({
    message: 'Include sample invoice records?',
    initialValue: true,
  })
  if (p.isCancel(result)) {
    p.cancel('Cancelled.')
    process.exit(1)
  }
  return result
}

async function assertWritableTarget(target: string): Promise<void> {
  try {
    const entries = await fs.readdir(target)
    if (entries.length > 0) {
      throw new Error(
        `Target directory '${target}' already exists and is not empty. Refusing to overwrite — pick a different project name or remove the directory first.`,
      )
    }
  } catch (err: unknown) {
    // ENOENT is the happy path — the directory doesn't exist yet.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}
