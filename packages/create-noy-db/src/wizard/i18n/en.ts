/**
 * English (`en`) wizard messages — the default locale.
 *
 * Editing note: if you change a key's value here, update the
 * matching key in every other locale bundle (`th.ts`, future
 * additions). The key-parity test in `__tests__/i18n.test.ts`
 * is the safety net: it fails if any locale is missing a key
 * or has an extra one, so a forgotten update surfaces in CI
 * rather than in a user report.
 */

import type { WizardMessages } from './types.js'

export const en: WizardMessages = {
  wizardIntro:
    'A wizard for noy-db — None Of Your DataBase.\n' +
    'Generates a fresh Nuxt 4 + Pinia + encrypted-store starter.',

  promptProjectName: 'Project name',
  promptProjectNamePlaceholder: 'my-noy-db-app',
  promptAdapter: 'Storage adapter',
  adapterBrowserLabel:
    'browser — localStorage / IndexedDB (recommended for web apps)',
  adapterFileLabel:
    'file — JSON files on disk (Electron / Tauri / USB workflows)',
  adapterMemoryLabel:
    'memory — no persistence (ideal for tests and demos)',
  promptSampleData: 'Include sample invoice records?',

  freshNextStepsTitle: 'Next steps',
  freshOutroDone: '✔ Done — happy encrypting!',

  augmentModeTitle: 'Augment mode',
  augmentDetectedPrefix: 'Detected existing Nuxt 4 project:',
  augmentDescription:
    'The wizard will add @noy-db/nuxt to your modules array\n' +
    'and a noydb: config key. You can review the diff before\n' +
    'anything is written to disk.',

  augmentProposedChangesTitle: 'Proposed changes',
  augmentApplyConfirm: 'Apply these changes?',

  augmentAlreadyConfiguredTitle: 'Already configured',
  augmentNothingToDo: 'Nothing to do:',
  augmentAlreadyOutro: '✔ Your Nuxt config is already wired up.',
  augmentAborted: 'Aborted — your config is unchanged.',
  augmentDryRunOutro: '✔ Dry run — no files were modified.',
  augmentNextStepTitle: 'Next step',
  augmentInstallIntro:
    'Install the @noy-db packages your config now depends on:',
  augmentInstallPmHint: '(or use npm/yarn/bun as appropriate)',
  augmentDoneOutro: '✔ Config updated — happy encrypting!',
  augmentUnsupportedPrefix: 'Cannot safely patch this config:',

  cancelled: 'Cancelled.',
}
