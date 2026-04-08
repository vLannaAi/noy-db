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
import { detectLocale, loadMessages, type WizardMessages } from './i18n/index.js'

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

function adapterLabels(msg: WizardMessages): Record<WizardAdapter, string> {
  return {
    browser: msg.adapterBrowserLabel,
    file: msg.adapterFileLabel,
    memory: msg.adapterMemoryLabel,
  }
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

  // Resolve the message bundle once at the top so every downstream
  // helper sees a consistent locale. Explicit `options.locale` wins;
  // otherwise we fall back to POSIX env-var detection (LC_ALL → LANG).
  // Tests pin the locale to keep snapshots deterministic.
  const msg = loadMessages(options.locale ?? detectLocale())

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
    return runAugmentMode(options, cwd, detection.configPath, msg)
  }

  return runFreshMode(options, cwd, yes, msg)
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
  msg: WizardMessages,
): Promise<WizardFreshResult> {
  // ── Resolve answers ────────────────────────────────────────────────
  // In non-interactive mode every prompt is short-circuited; in
  // interactive mode we only prompt for fields the caller didn't supply.
  const projectName = yes
    ? options.projectName ?? 'my-noy-db-app'
    : await promptProjectName(options.projectName, msg)

  const adapter: WizardAdapter = yes
    ? options.adapter ?? 'browser'
    : await promptAdapter(options.adapter, msg)

  const sampleData: boolean = yes
    ? options.sampleData ?? true
    : await promptSampleData(options.sampleData, msg)

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
      msg.freshNextStepsTitle,
    )
    p.outro(pc.green(msg.freshOutroDone))
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
  msg: WizardMessages,
): Promise<WizardAugmentResult> {
  const yes = options.yes ?? false
  const dryRun = options.dryRun ?? false

  if (!yes) {
    p.note(
      [
        `${pc.dim(msg.augmentDetectedPrefix)}`,
        `  ${pc.cyan(configPath)}`,
        '',
        msg.augmentDescription,
      ].join('\n'),
      msg.augmentModeTitle,
    )
  }

  // In augment mode we only need ONE prompt from the user: which
  // adapter to wire into the `noydb: { adapter }` key. Everything
  // else is decided by the config we're patching.
  const adapter: WizardAdapter = yes
    ? options.adapter ?? 'browser'
    : await promptAdapter(options.adapter, msg)

  const result = await augmentNuxtConfig({
    configPath,
    adapter,
    dryRun,
  })

  if (result.kind === 'already-configured') {
    if (!yes) {
      p.note(
        `${pc.yellow(msg.augmentNothingToDo)} ${result.reason}`,
        msg.augmentAlreadyConfiguredTitle,
      )
      p.outro(pc.green(msg.augmentAlreadyOutro))
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
      p.cancel(`${pc.red(msg.augmentUnsupportedPrefix)} ${result.reason}`)
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
    p.note(renderDiff(result.diff), msg.augmentProposedChangesTitle)
  }

  if (dryRun) {
    if (!yes) p.outro(pc.green(msg.augmentDryRunOutro))
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
      message: msg.augmentApplyConfirm,
      initialValue: true,
    })
    if (p.isCancel(confirmed) || confirmed !== true) {
      p.cancel(msg.augmentAborted)
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
          pc.dim(msg.augmentInstallIntro),
          '',
          `${pc.bold('pnpm add')} @noy-db/nuxt @noy-db/pinia @noy-db/core @noy-db/browser @pinia/nuxt pinia`,
          pc.dim(msg.augmentInstallPmHint),
        ].join('\n'),
        msg.augmentNextStepTitle,
      )
      p.outro(pc.green(msg.augmentDoneOutro))
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

async function promptProjectName(initial: string | undefined, msg: WizardMessages): Promise<string> {
  if (initial) {
    const err = validateProjectName(initial)
    if (err) throw new Error(err)
    return initial
  }
  const result = await p.text({
    message: msg.promptProjectName,
    placeholder: msg.promptProjectNamePlaceholder,
    initialValue: 'my-noy-db-app',
    validate: (v) => validateProjectName(v ?? '') ?? undefined,
  })
  if (p.isCancel(result)) {
    p.cancel(msg.cancelled)
    process.exit(1)
  }
  return result
}

async function promptAdapter(initial: WizardAdapter | undefined, msg: WizardMessages): Promise<WizardAdapter> {
  if (initial) return initial
  const labels = adapterLabels(msg)
  const result = await p.select<WizardAdapter>({
    message: msg.promptAdapter,
    options: (['browser', 'file', 'memory'] as const).map((value) => ({
      value,
      label: labels[value],
    })),
    initialValue: 'browser',
  })
  if (p.isCancel(result)) {
    p.cancel(msg.cancelled)
    process.exit(1)
  }
  return result
}

async function promptSampleData(initial: boolean | undefined, msg: WizardMessages): Promise<boolean> {
  if (typeof initial === 'boolean') return initial
  const result = await p.confirm({
    message: msg.promptSampleData,
    initialValue: true,
  })
  if (p.isCancel(result)) {
    p.cancel(msg.cancelled)
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
