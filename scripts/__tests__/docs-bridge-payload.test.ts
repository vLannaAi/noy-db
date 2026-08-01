import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPayload, isFirstPublishFromError } from '../docs-bridge/build-payload.mjs'

let root: string

const caps = {
  'to-alpha': { factory: 'toAlpha', shape: 'record', capabilities: { casAtomic: true }, optionDependent: false },
  'to-beta': { factory: 'toBeta', shape: 'record', capabilities: { casAtomic: false }, optionDependent: false },
  'to-gamma': { factory: 'toGamma', shape: 'record', capabilities: { casAtomic: true }, optionDependent: true, conditionalBits: ['casAtomic'] },
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'noydb-bridge-fixture-'))
  // The real root package.json is a private `0.0.0` shell — the lockstep
  // version lives on the packages. The fixture keeps them different on purpose.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'noy-db-monorepo', version: '0.0.0', private: true }))
  mkdirSync(join(root, 'packages'))
  // A non-store package next door — the scan must not pick it up, but it IS
  // where the canonical version is read from.
  mkdirSync(join(root, 'packages', 'hub'))
  writeFileSync(join(root, 'packages', 'hub', 'package.json'), JSON.stringify({ name: '@noy-db/hub', version: '0.9.0-pre.1' }))

  for (const dir of ['to-alpha', 'to-beta', 'to-gamma']) {
    mkdirSync(join(root, 'packages', dir))
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify({
      name: `@noy-db/${dir}`, version: '0.9.0-pre.1', description: `${dir} store`,
      peerDependencies: { '@noy-db/hub': 'workspace:*' },
    }))
  }
  writeFileSync(join(root, 'packages', 'to-alpha', 'CHANGELOG.md'), '# @noy-db/to-alpha\n\n## 0.9.0-pre.1\n\n### Fix: x\n\n- fixed x\n')
  writeFileSync(join(root, 'packages', 'to-beta', 'CHANGELOG.md'), '# @noy-db/to-beta\n\n## 0.1.0\n\n- ancient\n')
  writeFileSync(join(root, 'packages', 'to-gamma', 'CHANGELOG.md'), '# @noy-db/to-gamma\n\n## 0.9.0-pre.1\n\n- wrapped\n')
})

const build = (over: Partial<Parameters<typeof buildPayload>[0]> = {}) => buildPayload({
  rootDir: root, caps, tag: 'v0.9.0-pre.1', channel: 'next',
  runUrl: 'https://example.com/run/1', isFirstPublish: () => false, ...over,
})

describe('buildPayload', () => {
  it('assembles the bridge:1 schema for the essential stores under packages/', () => {
    const p = build()
    expect(p.bridge).toBe(1)
    expect(p.repo).toBe('vLannaAi/noy-db')
    // Read from packages/hub, NOT the root package.json: noy-db's root is a
    // private 0.0.0 shell, so taking the root version (as noy-db-to's producer
    // does, where the root IS versioned) would ship "0.0.0" to the docs side.
    expect(p.version).toBe('0.9.0-pre.1')
    expect(p.tag).toBe('v0.9.0-pre.1')
    expect(p.channel).toBe('next')
    expect(p.runUrl).toBe('https://example.com/run/1')
    expect(p.packages.map(x => x.dir)).toEqual(['to-alpha', 'to-beta', 'to-gamma'])
  })

  it('carries per-package facts, capabilities and the verbatim changelog section', () => {
    const alpha = build().packages.find(x => x.dir === 'to-alpha')!
    expect(alpha.name).toBe('@noy-db/to-alpha')
    expect(alpha.description).toBe('to-alpha store')
    expect(alpha.factory).toBe('toAlpha')
    expect(alpha.shape).toBe('record')
    expect(alpha.capabilities).toEqual({ casAtomic: true })
    expect(alpha.changeType).toBe('updated')
    expect(alpha.changelog).toBe('### Fix: x\n\n- fixed x')
  })

  it('carries optionDependent through, so a varying capability is not read as fixed', () => {
    // to-meter INHERITS the wrapped store's capabilities (it is built with
    // hub's `wrapStore`), so its recorded value describes the representative
    // configuration only. Dropping the flag would present one arbitrary
    // wrapping as the store's fixed capability surface.
    const gamma = build().packages.find(x => x.dir === 'to-gamma')!
    expect(gamma.shape).toBe('record')
    expect(gamma.optionDependent).toBe(true)
    expect(gamma.capabilities).toEqual({ casAtomic: true })
  })

  it('carries per-bit conditionalBits through, and omits the field when the dump has none (#930)', () => {
    // The store-level flag says "something varies"; conditionalBits says WHICH
    // bits — so a consumer can strict-compare every other bit instead of
    // skipping the store wholesale.
    const p = build()
    expect(p.packages.find(x => x.dir === 'to-gamma')!.conditionalBits).toEqual(['casAtomic'])
    expect(p.packages.find(x => x.dir === 'to-alpha')!).not.toHaveProperty('conditionalBits')
    expect(p.packages.find(x => x.dir === 'to-beta')!).not.toHaveProperty('conditionalBits')
  })

  it('classifies changeType: added wins over changelog presence', () => {
    const alpha = build({ isFirstPublish: (n: string) => n === '@noy-db/to-alpha' })
      .packages.find(x => x.dir === 'to-alpha')!
    expect(alpha.changeType).toBe('added')
  })

  it('classifies changeType: version-only when no section exists for this version', () => {
    const beta = build().packages.find(x => x.dir === 'to-beta')!
    expect(beta.changeType).toBe('version-only')
    expect(beta.changelog).toBeNull()
  })

  it('reports hubPeerRange as null — noy-db stores are lockstep, not ranged', () => {
    // noy-db-to pins hub by a real semver range, so its payload carries one.
    // In-repo stores pin `workspace:*`, which is a workspace directive, not a
    // consumer-meaningful range — emitting it verbatim would mislead the docs
    // side. The lockstep `version` above already answers "which hub".
    expect(build().hubPeerRange).toBeNull()
  })

  it('throws when a store directory has no caps entry (wiring drift)', () => {
    const drifted = mkdtempSync(join(tmpdir(), 'noydb-bridge-drift-'))
    writeFileSync(join(drifted, 'package.json'), JSON.stringify({ version: '0.0.0' }))
    mkdirSync(join(drifted, 'packages'))
    mkdirSync(join(drifted, 'packages', 'hub'))
    writeFileSync(join(drifted, 'packages', 'hub', 'package.json'), JSON.stringify({ name: '@noy-db/hub', version: '1.0.0' }))
    mkdirSync(join(drifted, 'packages', 'to-unwired'))
    writeFileSync(join(drifted, 'packages', 'to-unwired', 'package.json'), JSON.stringify({ name: '@noy-db/to-unwired', version: '1.0.0' }))

    expect(() => buildPayload({
      rootDir: drifted, caps, tag: 'v1.0.0', channel: 'latest',
      runUrl: 'u', isFirstPublish: () => false,
    })).toThrow(/to-unwired/)
  })
})

describe('isFirstPublishFromError', () => {
  it('treats npm E404 as never-published', () => {
    expect(isFirstPublishFromError({ stderr: 'npm ERR! code E404' })).toBe(true)
  })

  it('does not treat a transient failure as never-published', () => {
    // Mislabelling a network blip as "added" would tell the docs side to write
    // a brand-new page for a store that has shipped for months.
    expect(isFirstPublishFromError({ stderr: 'ETIMEDOUT' })).toBe(false)
  })
})
