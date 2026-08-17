/**
 * Both `scripts/check-architecture.mjs` via-guard allowlists end EMPTY, and
 * both still FIRE on a synthetic violation — merged into one file (#650
 * whole-branch fix wave, dm19 hardening).
 *
 * Was two files: `via-layering-empty.test.ts` (#650 Task 6, #626 retirement)
 * and `via-enclave-empty.test.ts` (#650 Task 7). Both `execFileSync` the
 * SAME `check-architecture.mjs` against the shared repo working tree, each
 * planting/removing its own synthetic violation file mid-test. As two
 * separate test FILES, vitest is free to schedule them in different worker
 * threads/processes concurrently — one test's synthetic file (or its
 * "clean again" assertion) could transiently race the other's run of the
 * SAME checker over the SAME tree (observed as a transient failure in
 * `task-7-report.md`'s Fix wave 1 verification, reproduced as a pre-existing
 * cross-test race, not a regression). Tests within a single file run
 * sequentially by default (no `.concurrent`) — merging removes the race
 * entirely without weakening either guard's coverage. Every assertion below
 * is byte-identical to its original file; only the file boundary changed.
 *
 * - `VIA_SHAPE_ALLOWLIST` (Check 14, `via-layering`, the kernel→via
 *   direction) — empty since #650 Task 6.
 * - `VIA_ENCLAVE_ALLOWLIST` (Check 15, `via-enclave-isolation`, the reverse
 *   via→kernel/enclave direction) — empty since #629 Task 4, gained its
 *   own synthetic-fire proof in #650 Task 7.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../../${rel}`, import.meta.url))
}

const CHECK_SCRIPT = repoPath('scripts/check-architecture.mjs')
const JOIN_TS = repoPath('packages/hub/src/kernel/query/join.ts')
// Any *.ts file under packages/hub/src/kernel/** is scanned by checkViaLayering
// (`walkTsFiles(kernelDir, ...)`) — planting a throwaway file directly there
// is the mechanical way to prove the guard still fires, without touching any
// real kernel file.
const LAYERING_SYNTHETIC_FILE = repoPath('packages/hub/src/kernel/__via_layering_synthetic__.ts')
// Any *.ts file under packages/hub/src/via/** is scanned by
// checkViaEnclaveIsolation — planting a throwaway file directly there is the
// mechanical way to prove the guard still fires, without touching any real
// via/ file. lookup/ is a via family dir; any via family dir works.
const ENCLAVE_SYNTHETIC_FILE = repoPath('packages/hub/src/via/lookup/__via_enclave_synthetic__.ts')

/**
 * Every throwaway file this suite plants, in one list (#1106).
 *
 * ## Why a sweep exists on top of the per-test `try/finally`
 *
 * Each test already removes its own file in a `finally`, and that is correct for
 * every ordinary outcome including an assertion failure. It does **not** survive
 * the process being KILLED — a `SIGKILL` skips `finally` entirely.
 *
 * The residue is unusually costly for this particular suite, because the planted
 * files exist precisely to make `check:architecture` fail. A stranded one makes
 * the guard fail **for real**, for everyone, until somebody notices — so a
 * killed test run stops looking like a killed test run and starts looking like
 * an architecture violation. That has already cost time twice.
 *
 * `beforeAll` therefore clears leftovers so the suite self-heals from a
 * previously-killed run, and `afterAll` clears them again in case a test aborted
 * between planting and its own cleanup.
 */
const SYNTHETIC_FILES: readonly string[] = [
  repoPath('packages/hub/src/kernel/__via_layering_synthetic__.ts'),
  repoPath('packages/hub/src/kernel/__via_layering_side_effect_synthetic__.ts'),
  repoPath('packages/hub/src/kernel/__via_layering_default_synthetic__.ts'),
  repoPath('packages/hub/src/via/lookup/__via_enclave_synthetic__.ts'),
]

function sweepSyntheticFiles(): string[] {
  const removed: string[] = []
  for (const f of SYNTHETIC_FILES) {
    if (existsSync(f)) { unlinkSync(f); removed.push(f) }
  }
  return removed
}

beforeAll(() => {
  const removed = sweepSyntheticFiles()
  if (removed.length > 0) {
    // Loud on purpose: self-healing silently would hide that a previous run was
    // killed, and that is worth knowing.
    console.warn(`[via-guards-empty] cleared ${removed.length} stranded synthetic file(s) from a previous killed run`)
  }
})

afterAll(() => { sweepSyntheticFiles() })

interface CheckResult {
  readonly status: number
  readonly output: string
}

function runArchitectureCheck(): CheckResult {
  try {
    const output = execFileSync(process.execPath, [CHECK_SCRIPT], {
      cwd: repoPath('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('via-layering allowlist ends EMPTY (#650 Task 6, #626 retirement)', () => {
  it('VIA_SHAPE_ALLOWLIST is the empty map — no grandfathered kernel→via import remains', () => {
    const src = readFileSync(CHECK_SCRIPT, 'utf8')
    const m = src.match(/const VIA_SHAPE_ALLOWLIST = new Map\(\[([\s\S]*?)\]\)/)
    expect(m).not.toBeNull()
    const body = (m![1] ?? '').replace(/\/\/.*$/gm, '').trim()
    expect(body).toBe('')
  })

  it('join.ts no longer imports via/i18n (or any via/) directly', () => {
    const joinSrc = readFileSync(JOIN_TS, 'utf8')
    expect(joinSrc).not.toMatch(/via\/i18n/)
    expect(joinSrc).not.toMatch(/from ['"].*\/via\//)
  })

  it('check-architecture.mjs passes clean at HEAD (via-layering included)', () => {
    const result = runArchitectureCheck()
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Architecture invariants OK/)
  })

  it('the guard still FIRES on a synthetic kernel/** -> via/** import (the phase-B deletion recipe)', () => {
    expect(existsSync(LAYERING_SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      LAYERING_SYNTHETIC_FILE,
      "import { applyI18nLocale } from '../via/i18n/core.js'\nexport const _syntheticViaLayeringProbe = applyI18nLocale\n",
    )
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-layering/)
      expect(result.output).toMatch(/__via_layering_synthetic__/)
    } finally {
      unlinkSync(LAYERING_SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })

  // #632: STATIC_IMPORT_FROM_RE (shared by port-layering, enclave-barrel-only,
  // via-layering, and via-enclave-isolation) originally only matched
  // `import/export … from '…'` clauses with a named/`* as`/bare-`*` binding.
  // Side-effect imports (`import '…'`, no binding, no `from`) and default
  // imports (`import x from '…'`) silently slipped every guard that shares
  // this regex. These two tests reuse the via-layering recipe above (same
  // real target, via/i18n/core.js) with those two forms instead of a
  // named import, proving the widened scanner now catches them too. Kept in
  // THIS file (not a new one) to avoid the exact cross-file subprocess race
  // documented at the top of this file — a second file invoking
  // check-architecture.mjs concurrently could observe the other's synthetic
  // file mid-run.
  const SIDE_EFFECT_SYNTHETIC_FILE = repoPath(
    'packages/hub/src/kernel/__via_layering_side_effect_synthetic__.ts',
  )
  const DEFAULT_IMPORT_SYNTHETIC_FILE = repoPath(
    'packages/hub/src/kernel/__via_layering_default_synthetic__.ts',
  )

  it('the guard fires on a synthetic side-effect import (`import "../via/…"`, no `from` clause) (#632)', () => {
    expect(existsSync(SIDE_EFFECT_SYNTHETIC_FILE)).toBe(false)
    writeFileSync(SIDE_EFFECT_SYNTHETIC_FILE, "import '../via/i18n/core.js'\n")
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-layering/)
      expect(result.output).toMatch(/__via_layering_side_effect_synthetic__/)
    } finally {
      unlinkSync(SIDE_EFFECT_SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })

  it('the guard fires on a synthetic default import (`import x from "../via/…"`) (#632)', () => {
    expect(existsSync(DEFAULT_IMPORT_SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      DEFAULT_IMPORT_SYNTHETIC_FILE,
      "import applyI18nLocale from '../via/i18n/core.js'\nexport const _syntheticDefaultImportProbe = applyI18nLocale\n",
    )
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-layering/)
      expect(result.output).toMatch(/__via_layering_default_synthetic__/)
    } finally {
      unlinkSync(DEFAULT_IMPORT_SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })
})

describe('via-enclave-isolation allowlist stays EMPTY (#650 Task 7)', () => {
  it('VIA_ENCLAVE_ALLOWLIST is the empty map — no grandfathered via->enclave import remains', () => {
    const src = readFileSync(CHECK_SCRIPT, 'utf8')
    const m = src.match(/const VIA_ENCLAVE_ALLOWLIST = new Map\(\[([\s\S]*?)\]\)/)
    expect(m).not.toBeNull()
    const body = (m![1] ?? '').replace(/\/\/.*$/gm, '').trim()
    expect(body).toBe('')
  })

  it('check-architecture.mjs passes clean at HEAD (via-enclave-isolation included)', () => {
    const result = runArchitectureCheck()
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Architecture invariants OK/)
  })

  it('the guard still FIRES on a synthetic via/** -> kernel/enclave/ import', () => {
    expect(existsSync(ENCLAVE_SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      ENCLAVE_SYNTHETIC_FILE,
      "import { RecordCodec } from '../../kernel/enclave/index.js'\nexport const _syntheticViaEnclaveProbe = RecordCodec\n",
    )
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-enclave-isolation/)
      expect(result.output).toMatch(/__via_enclave_synthetic__/)
    } finally {
      unlinkSync(ENCLAVE_SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })
})
