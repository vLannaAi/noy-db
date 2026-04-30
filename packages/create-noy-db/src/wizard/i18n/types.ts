/**
 * Internationalization types for the `@noy-db/create` wizard.
 *
 * `WizardMessages` is the full set of user-facing strings the
 * wizard emits: prompt labels, note titles, note bodies, outro
 * messages, confirmation questions. Every locale bundle exports
 * a `WizardMessages` constant; the key-parity test ensures they
 * all have the exact same set of keys so we never ship a locale
 * that's missing a string.
 *
 * ## What's translated, what's not
 *
 * **Translated:** prompts, note titles, confirmation messages,
 * success banners, and the short summaries shown before each
 * major step. These are the load-bearing "does the user
 * understand what's happening?" strings.
 *
 * **Not translated:** validation error messages ("Project name
 * cannot be empty"), diagnostic output, stack traces, structured
 * errors from `@noy-db/core`. These stay in English so bug
 * reports from any locale look the same in an issue tracker.
 * Thai developers filing bugs with English error messages can
 * get help from English-speaking maintainers; the reverse is
 * harder.
 *
 * ## Why a flat shape instead of nested namespaces
 *
 * Flat keys are the simplest thing that can work. With ~30
 * strings, namespacing (e.g., `prompts.projectName`) would just
 * add ceremony without helping discoverability. If the set grows
 * past ~100 strings we can revisit.
 */

export type Locale = 'en' | 'th'

export interface WizardMessages {
  // ─── Wizard intro ────────────────────────────────────────────
  /** Banner shown under the intro badge in fresh-project mode. */
  wizardIntro: string

  // ─── Fresh-mode prompts ──────────────────────────────────────
  /** "Project name" prompt label. */
  promptProjectName: string
  /** Placeholder shown inside the project-name input. */
  promptProjectNamePlaceholder: string
  /** "Storage adapter" select prompt label. */
  promptAdapter: string
  /** Label for the browser adapter option. */
  adapterBrowserLabel: string
  /** Label for the file adapter option. */
  adapterFileLabel: string
  /** Label for the memory adapter option. */
  adapterMemoryLabel: string
  /** "Include sample invoice records?" confirm label. */
  promptSampleData: string

  // ─── Fresh-mode outro ────────────────────────────────────────
  /** Title of the "Next steps" note block. */
  freshNextStepsTitle: string
  /** Success banner shown after the fresh project is created. */
  freshOutroDone: string

  // ─── Augment-mode framing ────────────────────────────────────
  /** Title of the "augment mode detected" note block. */
  augmentModeTitle: string
  /** First line of the augment-mode intro body — followed by the path. */
  augmentDetectedPrefix: string
  /** Second/third lines explaining what augment mode will do. */
  augmentDescription: string

  // ─── Augment-mode diff preview ───────────────────────────────
  /** Title of the diff preview note block. */
  augmentProposedChangesTitle: string
  /** Question shown at the confirm prompt. */
  augmentApplyConfirm: string

  // ─── Augment-mode outcomes ───────────────────────────────────
  /** Title when the config is already configured. */
  augmentAlreadyConfiguredTitle: string
  /** Prefix for the "already configured" reason line. */
  augmentNothingToDo: string
  /** Success banner when there's nothing to do. */
  augmentAlreadyOutro: string
  /** Cancel message when the user declines the confirm prompt. */
  augmentAborted: string
  /** Success banner on dry-run success. */
  augmentDryRunOutro: string
  /** Title of the "install these packages next" note block. */
  augmentNextStepTitle: string
  /** Prose line above the install command. */
  augmentInstallIntro: string
  /** Dim hint under the install command. */
  augmentInstallPmHint: string
  /** Success banner after a real augmentation write. */
  augmentDoneOutro: string
  /** Prefix for the "unsupported shape" error message. */
  augmentUnsupportedPrefix: string

  // ─── Shared ──────────────────────────────────────────────────
  /** Cancellation message used by Ctrl-C handlers. */
  cancelled: string
}
