/**
 * Types shared between the wizard, the bins, and the test harness.
 *
 * `WizardOptions` is the input shape — both the prompt UI and the test
 * helper accept the same object so tests can skip the interactive prompts
 * by passing answers up front.
 */

import type { Locale } from './i18n/types.js'

/**
 * Which built-in adapter to wire into the generated `nuxt.config.ts`.
 *
 * - `browser` — localStorage / IndexedDB. The recommended default for
 * because it makes the generated app a real PWA-friendly demo.
 * - `file` — JSON files on disk. Useful for Electron / Tauri wraps and
 *   for the USB-stick workflow.
 * - `memory` — no persistence. Mostly useful for tests and demos. Picked
 *   automatically when running in CI to avoid touching the test runner's
 *   localStorage.
 */
export type WizardAdapter = 'browser' | 'file' | 'memory'

/**
 * Which starter template to scaffold in fresh-project mode.
 *
 * - `nuxt-default` — Nuxt 4 + Pinia + in-nuxt, SSR-friendly. Default.
 * - `vanilla` — Vite + TS, no framework. Smallest footprint.
 * - `vite-vue` — Vite + Vue 3 + Pinia + in-pinia. Client-side SPA.
 * - `electron` — Electron + Vue 3 + to-file. USB-stick / local-disk workflow.
 *
 * Augment mode (detected Nuxt project) ignores this field — the
 * mutation path is shared regardless of the original scaffold.
 */
export type WizardTemplate = 'nuxt-default' | 'vanilla' | 'vite-vue' | 'electron'

/** Every built-in template name, exposed for validation + help text. */
export const WIZARD_TEMPLATES: readonly WizardTemplate[] = [
  'nuxt-default',
  'vanilla',
  'vite-vue',
  'electron',
] as const

/**
 * Inputs to `runWizard()`. All fields are optional — when a field is
 * omitted the wizard prompts for it. Tests pass everything to skip
 * prompts entirely.
 */
export interface WizardOptions {
  /**
   * Project directory name. The wizard creates `<cwd>/<projectName>/`
   * and refuses to overwrite an existing non-empty directory.
   */
  projectName?: string

  /**
   * Adapter to use in the generated `nuxt.config.ts`. See `WizardAdapter`.
   */
  adapter?: WizardAdapter

  /**
   * Starter template to scaffold. Defaults to `'nuxt-default'` when
   * omitted. Ignored in augment mode (the existing project's shape
   * determines the mutation path).
   */
  template?: WizardTemplate

  /**
   * Optional sync-target adapter. When set, the
   * generated project wires a `sync: [...]` entry in
   * `createNoydb()` alongside the primary store. When omitted, the
   * project runs local-only.
   *
   * Accepts the same adapter identifiers as `adapter` but is
   * semantically orthogonal — pick the primary adapter based on
   * "where do I want records persisted locally?" and the sync
   * adapter based on "where do I want them replicated?".
   */
  syncAdapter?: WizardAdapter | 'none'

  /**
   * Whether to include the seed-data invoices in the generated app. When
   * `true`, the page renders pre-filled records on first load so the user
   * sees something immediately. When `false`, the page starts empty and
   * waits for the user to click "Add invoice".
   */
  sampleData?: boolean

  /**
   * Working directory the project should be created in. Defaults to
   * `process.cwd()`. Tests pass a temp directory.
   */
  cwd?: string

  /**
   * When `true`, skip ALL interactive prompts and use only the values
   * supplied above. Missing values become defaults (`browser`, `true`,
   * a generated project name). This is the path tests take.
   */
  yes?: boolean

  /**
   * Augment mode: show the proposed diff against an existing
   * `nuxt.config.ts` but do not write the file. Only meaningful
   * when the wizard detects an existing Nuxt project in `cwd`. A
   * no-op in fresh-project mode.
   */
  dryRun?: boolean

  /**
   * Force fresh-project mode even when cwd looks like an existing
   * Nuxt project. Useful for CI tests that create a scratch
   * directory inside a parent that happens to have a nuxt.config.
   */
  forceFresh?: boolean

  /**
   * Locale for the wizard's user-facing prompts and notes. When
   * omitted, the wizard auto-detects from `LC_ALL` / `LANG` env
   * vars and falls back to `'en'`. Tests pin a value to make
   * snapshot output deterministic.
   *
   * Validation/error messages are NOT translated — they stay in
   * English so bug reports look the same across locales.
   */
  locale?: Locale
}

/**
 * Output of `runWizard()` in fresh-project mode. The augment-mode
 * path uses `WizardAugmentResult` instead; the caller narrows on
 * the `kind` discriminator.
 */
export interface WizardFreshResult {
  readonly kind: 'fresh'
  /** Resolved options after prompts/defaults. */
  readonly options: {
    readonly projectName: string
    readonly adapter: WizardAdapter
    readonly sampleData: boolean
    readonly cwd: string
    readonly template: WizardTemplate
    readonly syncAdapter: WizardAdapter | 'none'
  }
  /** Absolute path of the created project directory. */
  readonly projectPath: string
  /** Relative paths of every file the wizard wrote, sorted alphabetically. */
  readonly files: string[]
}

/**
 * Output of `runWizard()` in augment mode. Carries the outcome of
 * the magicast-based config mutation — either the file was
 * actually written (`changed: true`), the file was already
 * configured (`changed: false, reason: 'already-configured'`),
 * or the user cancelled at the confirmation prompt (`changed: false,
 * reason: 'cancelled'`), or we were in dry-run (`changed: false,
 * reason: 'dry-run'`).
 */
export interface WizardAugmentResult {
  readonly kind: 'augment'
  readonly configPath: string
  readonly adapter: WizardAdapter
  readonly changed: boolean
  readonly reason: 'written' | 'already-configured' | 'cancelled' | 'dry-run' | 'unsupported-shape'
  /** The unified diff that was shown to the user, if any. */
  readonly diff?: string
}

export type WizardResult = WizardFreshResult | WizardAugmentResult
