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
 * - `VIA_SHAPE_ALLOWLIST` (Check 14, `via-layering`, the kernel→shape
 *   direction) — empty since #650 Task 6.
 * - `VIA_ENCLAVE_ALLOWLIST` (Check 15, `via-enclave-isolation`, the reverse
 *   shape→kernel/enclave direction) — empty since #629 Task 4, gained its
 *   own synthetic-fire proof in #650 Task 7.
 */
import { describe, it, expect } from 'vitest'
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
// Any *.ts file under packages/hub/src/shape/via-*/** is scanned by
// checkViaEnclaveIsolation — planting a throwaway file directly there is the
// mechanical way to prove the guard still fires, without touching any real
// shape/ file. via-lookup/ is a via-* dir; any via-* dir works.
const ENCLAVE_SYNTHETIC_FILE = repoPath('packages/hub/src/shape/via-lookup/__via_enclave_synthetic__.ts')

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
  it('VIA_SHAPE_ALLOWLIST is the empty map — no grandfathered kernel→shape import remains', () => {
    const src = readFileSync(CHECK_SCRIPT, 'utf8')
    const m = src.match(/const VIA_SHAPE_ALLOWLIST = new Map\(\[([\s\S]*?)\]\)/)
    expect(m).not.toBeNull()
    const body = (m![1] ?? '').replace(/\/\/.*$/gm, '').trim()
    expect(body).toBe('')
  })

  it('join.ts no longer imports shape/via-i18n (or any shape/) directly', () => {
    const joinSrc = readFileSync(JOIN_TS, 'utf8')
    expect(joinSrc).not.toMatch(/shape\/via-i18n/)
    expect(joinSrc).not.toMatch(/from ['"].*\/shape\//)
  })

  it('check-architecture.mjs passes clean at HEAD (via-layering included)', () => {
    const result = runArchitectureCheck()
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Architecture invariants OK/)
  })

  it('the guard still FIRES on a synthetic kernel/** -> shape/** import (the phase-B deletion recipe)', () => {
    expect(existsSync(LAYERING_SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      LAYERING_SYNTHETIC_FILE,
      "import { applyI18nLocale } from '../shape/via-i18n/core.js'\nexport const _syntheticViaLayeringProbe = applyI18nLocale\n",
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
})

describe('via-enclave-isolation allowlist stays EMPTY (#650 Task 7)', () => {
  it('VIA_ENCLAVE_ALLOWLIST is the empty map — no grandfathered shape->enclave import remains', () => {
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

  it('the guard still FIRES on a synthetic shape/via-*/** -> kernel/enclave/ import', () => {
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
