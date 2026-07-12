/**
 * The `via-layering` allowlist ends EMPTY (#650 Task 6, #626 retirement).
 *
 * `kernel/query/join.ts` was the ONE frozen `VIA_SHAPE_ALLOWLIST` baseline
 * (Check 14, `scripts/check-architecture.mjs`) — it imported
 * `shape/via-i18n/core.js` directly for join-layer i18n. Task 6 retires that
 * import (`join.ts` now consumes the binding's sync `presentForJoin` hook
 * instead) and empties the allowlist. This is the "phase-B deletion
 * recipe": empty the allowlist, verify the checker passes clean at HEAD,
 * then prove — mechanically, not by inspection — that the guard still
 * FIRES on a synthetic `kernel/** -> shape/**` import, so an empty
 * allowlist can never silently mean "the check stopped running."
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
const CHECK_ARCH_SRC = repoPath('scripts/check-architecture.mjs')
// Any *.ts file under packages/hub/src/kernel/** is scanned by checkViaLayering
// (`walkTsFiles(kernelDir, ...)`) — planting a throwaway file directly there
// is the mechanical way to prove the guard still fires, without touching any
// real kernel file.
const SYNTHETIC_FILE = repoPath('packages/hub/src/kernel/__via_layering_synthetic__.ts')

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
    const src = readFileSync(CHECK_ARCH_SRC, 'utf8')
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
    expect(existsSync(SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      SYNTHETIC_FILE,
      "import { applyI18nLocale } from '../shape/via-i18n/core.js'\nexport const _syntheticViaLayeringProbe = applyI18nLocale\n",
    )
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-layering/)
      expect(result.output).toMatch(/__via_layering_synthetic__/)
    } finally {
      unlinkSync(SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })
})
