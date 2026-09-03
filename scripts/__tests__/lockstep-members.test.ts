import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLockstepMember } from '../release/lockstep-members.mjs'

const PACKAGES = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages')

describe('isLockstepMember (#1313)', () => {
  it('the unscoped scaffolder is a member — the name shape is not the test', () => {
    expect(isLockstepMember({ name: 'create-noy-db', version: '0.3.4' })).toBe(true)
  })

  it('scoped members are members', () => {
    expect(isLockstepMember({ name: '@noy-db/hub', version: '0.7.0' })).toBe(true)
  })

  it('a private package has no version on the line to keep', () => {
    expect(isLockstepMember({ name: '@noy-db/typescript-config', private: true })).toBe(false)
  })

  it('a manifest with no name is not a package', () => {
    expect(isLockstepMember({})).toBe(false)
    expect(isLockstepMember(undefined)).toBe(false)
  })

  it('every published workspace package shares one version — create-noy-db included', () => {
    // The property #1313 lacked: measured over the real tree, so a member
    // drifting off the line fails here before it ships a pin nothing satisfies.
    const versions = new Map<string, string>()
    for (const dir of readdirSync(PACKAGES)) {
      const full = join(PACKAGES, dir, 'package.json')
      try { if (!statSync(join(PACKAGES, dir)).isDirectory()) continue } catch { continue }
      let pkg: { name?: string; version?: string; private?: boolean }
      try { pkg = JSON.parse(readFileSync(full, 'utf8')) } catch { continue }
      if (!isLockstepMember(pkg)) continue
      versions.set(pkg.name!, pkg.version!)
    }
    expect(versions.has('create-noy-db')).toBe(true)
    const distinct = new Set(versions.values())
    expect([...distinct], `versions on the line: ${JSON.stringify(Object.fromEntries(versions))}`).toHaveLength(1)
  })
})
