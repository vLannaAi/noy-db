/**
 * Public API for `create-noy-db`.
 *
 * Most users won't import from here — they'll invoke the package via
 * `npm create noy-db@latest` (which runs the `create-noy-db` bin) or
 * `pnpm exec noy-db <command>` (which runs the `noy-db` bin). The
 * programmatic exports below exist so:
 *
 *   1. Tests can call `runWizard()` and `addCollection()` directly
 *      without spawning a child process — much faster, much easier to
 *      assert against, and avoids the dependency on a real terminal.
 *
 *   2. Downstream tooling (devtools, IDE extensions, future `nuxi` CLI
 *      extension) can re-use the same prompt logic without forking it.
 *
 * Everything that's exported here is a public API contract — semver
 * applies. Internal helpers stay un-exported.
 */

export { runWizard } from './wizard/run.js'
export type { WizardOptions, WizardResult } from './wizard/types.js'

export { addCollection } from './commands/add.js'
export type { AddCollectionOptions } from './commands/add.js'

export { verifyIntegrity } from './commands/verify.js'
export type { VerifyResult } from './commands/verify.js'
