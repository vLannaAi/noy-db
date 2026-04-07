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
import type { WizardAdapter, WizardOptions, WizardResult } from './types.js'

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
 * Main entry point. Returns a `WizardResult` describing what was created.
 * Throws if the target directory already exists and is non-empty (refusing
 * to clobber existing work is a hard requirement — there's no `--force`).
 */
export async function runWizard(options: WizardOptions = {}): Promise<WizardResult> {
  const cwd = options.cwd ?? process.cwd()
  const yes = options.yes ?? false

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
