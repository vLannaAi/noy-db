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
    // Offline invariant: the built page must make ZERO network references.
    expect(html).not.toMatch(/https?:\/\//i)        // absolute http(s) URLs anywhere
    expect(html).not.toMatch(/\bwss?:\/\//i)        // websockets
    expect(html).not.toMatch(/=\s*["']\/\/[^/]/i)   // protocol-relative src/href
    expect(html).not.toMatch(/\bfetch\s*\(/)        // runtime fetch
    expect(html).not.toMatch(/\bimport\s*\(/)       // dynamic import (should be bundled away)
    expect(html).toContain('AUTHENTIC')
  })
})
