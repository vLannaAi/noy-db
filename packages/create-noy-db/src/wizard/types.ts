/**
 * Types shared between the wizard, the bins, and the test harness.
 *
 * `WizardOptions` is the input shape — both the prompt UI and the test
 * helper accept the same object so tests can skip the interactive prompts
 * by passing answers up front.
 */

/**
 * Which built-in adapter to wire into the generated `nuxt.config.ts`.
 *
 * - `browser` — localStorage / IndexedDB. The recommended default for
 *   v0.3 because it makes the generated app a real PWA-friendly demo.
 * - `file` — JSON files on disk. Useful for Electron / Tauri wraps and
 *   for the USB-stick workflow.
 * - `memory` — no persistence. Mostly useful for tests and demos. Picked
 *   automatically when running in CI to avoid touching the test runner's
 *   localStorage.
 */
export type WizardAdapter = 'browser' | 'file' | 'memory'

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
}

/**
 * Output of `runWizard()`. Contains the resolved options after prompting
 * (or defaulting), the absolute path of the created project, and a list
 * of files that were written. Tests use this to assert on the file set.
 */
export interface WizardResult {
  /** Resolved options after prompts/defaults. */
  options: Required<Omit<WizardOptions, 'cwd' | 'yes'>> & {
    cwd: string
  }
  /** Absolute path of the created project directory. */
  projectPath: string
  /** Relative paths of every file the wizard wrote, sorted alphabetically. */
  files: string[]
}
