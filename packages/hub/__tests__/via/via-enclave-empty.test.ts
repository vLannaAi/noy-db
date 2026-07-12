/**
 * The `via-enclave-isolation` allowlist stays EMPTY (#650 Task 7 — phase D's
 * final task, closing the arc end-state guard coverage the brief's Final
 * Steps require: "verify VIA_SHAPE_ALLOWLIST + VIA_ENCLAVE_ALLOWLIST both
 * EMPTY and both fire on synthetics"). Check 14 (`via-layering`, the
 * kernel→shape direction) already has this mechanical proof
 * (`via-layering-empty.test.ts`, #650 Task 6). Check 15
 * (`via-enclave-isolation`, the REVERSE direction — no file under
 * `shape/via-*` (any depth) may reach `kernel/enclave/`) has been empty
 * since #629 Task 4 (the
 * `DictionaryHandle` → `reservedEnvelopes` cutover) but never had its own
 * synthetic-fire proof until now — this file completes that pair, using the
 * exact same "phase-B deletion recipe" technique.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../../${rel}`, import.meta.url))
}

const CHECK_SCRIPT = repoPath('scripts/check-architecture.mjs')
// Any *.ts file under packages/hub/src/shape/via-*/** is scanned by
// checkViaEnclaveIsolation — planting a throwaway file directly there is the
// mechanical way to prove the guard still fires, without touching any real
// shape/ file. via-lookup/ is this task's own feature dir; any via-* dir works.
const SYNTHETIC_FILE = repoPath('packages/hub/src/shape/via-lookup/__via_enclave_synthetic__.ts')

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
    expect(existsSync(SYNTHETIC_FILE)).toBe(false)
    writeFileSync(
      SYNTHETIC_FILE,
      "import { RecordCodec } from '../../kernel/enclave/index.js'\nexport const _syntheticViaEnclaveProbe = RecordCodec\n",
    )
    try {
      const result = runArchitectureCheck()
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/via-enclave-isolation/)
      expect(result.output).toMatch(/__via_enclave_synthetic__/)
    } finally {
      unlinkSync(SYNTHETIC_FILE)
    }
    // Reverted — the checker is clean again, proving the failure above was
    // caused by the synthetic file and not some other pre-existing drift.
    const after = runArchitectureCheck()
    expect(after.status).toBe(0)
  })
})
