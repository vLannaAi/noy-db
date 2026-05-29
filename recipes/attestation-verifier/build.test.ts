import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist/verifier.html')

describe('verifier.html build', () => {
  beforeAll(() => { execFileSync('node', ['build.mjs'], { cwd: root }) })

  it('emits a single self-contained file with no external network references', () => {
    expect(existsSync(dist)).toBe(true)
    const html = readFileSync(dist, 'utf8')
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i)
    expect(html).toContain('AUTHENTIC')
  })
})
