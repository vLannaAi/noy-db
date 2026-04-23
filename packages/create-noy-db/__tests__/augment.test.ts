/**
 * Wizard augment-mode tests — #37.
 *
 * Two modules under test:
 *   - `wizard/detect.ts` — does cwd look like an existing Nuxt 4 project?
 *   - `wizard/augment.ts` — magicast-based config mutation
 *
 * Everything runs against temp dirs created via `os.tmpdir()` and
 * cleaned up in `afterEach`. No network, no shared state between
 * tests, no dependency on @clack/prompts (the augment module is a
 * pure function; prompts live in run.ts and are integration-tested
 * separately via the `runWizard({ yes: true })` path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectNuxtProject } from '../src/wizard/detect.js'
import { augmentNuxtConfig, writeAugmentedConfig } from '../src/wizard/augment.js'
import { runWizard } from '../src/wizard/run.js'

// ─── Fixture helpers ────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'noy-db-augment-test-'))
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

async function writeConfig(dir: string, content: string): Promise<string> {
  const configPath = path.join(dir, 'nuxt.config.ts')
  await fs.writeFile(configPath, content, 'utf8')
  return configPath
}

async function writePackageJson(
  dir: string,
  content: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(content, null, 2),
    'utf8',
  )
}

// ─── detectNuxtProject ──────────────────────────────────────────────

describe('detectNuxtProject', () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await rmrf(tmp) })

  it('returns existing=false on an empty directory', async () => {
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(false)
    expect(r.configPath).toBeNull()
    expect(r.reasons).toContain('No nuxt.config.{ts,js,mjs} in cwd')
  })

  it('returns existing=false when only a config file is present (no package.json)', async () => {
    await writeConfig(tmp, 'export default defineNuxtConfig({})')
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(false)
    expect(r.configPath).not.toBeNull()
    expect(r.reasons.some((s) => s.includes('no package.json'))).toBe(true)
  })

  it('returns existing=false when package.json lacks nuxt', async () => {
    await writeConfig(tmp, 'export default defineNuxtConfig({})')
    await writePackageJson(tmp, {
      name: 'sad-project',
      dependencies: { react: '^18.0.0' },
    })
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(false)
    expect(r.reasons.some((s) => s.includes('does not list `nuxt`'))).toBe(true)
  })

  it('returns existing=true when config + nuxt dep are both present (dependencies)', async () => {
    await writeConfig(tmp, 'export default defineNuxtConfig({})')
    await writePackageJson(tmp, {
      name: 'happy-project',
      dependencies: { nuxt: '^4.4.0' },
    })
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(true)
    expect(r.configPath).toMatch(/nuxt\.config\.ts$/)
    expect(r.reasons.some((s) => s.includes('Found nuxt@'))).toBe(true)
  })

  it('returns existing=true when nuxt is in devDependencies instead', async () => {
    await writeConfig(tmp, 'export default defineNuxtConfig({})')
    await writePackageJson(tmp, {
      name: 'happy-dev',
      devDependencies: { nuxt: '^4.4.0' },
    })
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(true)
  })

  it('rejects a malformed package.json gracefully (no throw)', async () => {
    await writeConfig(tmp, 'export default defineNuxtConfig({})')
    await fs.writeFile(path.join(tmp, 'package.json'), '{ not valid json', 'utf8')
    const r = await detectNuxtProject(tmp)
    expect(r.existing).toBe(false)
    expect(r.reasons.some((s) => s.includes('not valid JSON'))).toBe(true)
  })
})

// ─── augmentNuxtConfig ──────────────────────────────────────────────

describe('augmentNuxtConfig', () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await rmrf(tmp) })

  it('adds @noy-db/nuxt to an empty defineNuxtConfig modules array', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: [],\n})\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    expect(r.kind).toBe('proposed-change')
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    expect(r.newCode).toContain('@noy-db/in-nuxt')
    expect(r.newCode).toContain('noydb')
    expect(r.newCode).toContain("adapter: 'browser'")
  })

  it('creates a modules array when none exists', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  devtools: { enabled: true },\n})\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'file' })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    expect(r.newCode).toContain('@noy-db/in-nuxt')
    expect(r.newCode).toContain("adapter: 'file'")
    // The existing devtools key should still be present.
    expect(r.newCode).toContain('devtools')
  })

  it('adds to an existing non-empty modules array', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: ['@pinia/nuxt'],\n})\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    // Both modules should be present in the new code.
    expect(r.newCode).toContain('@pinia/nuxt')
    expect(r.newCode).toContain('@noy-db/in-nuxt')
  })

  it('is idempotent — second run returns already-configured', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: [],\n})\n`,
    )
    // First augment: write the file.
    const first = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    if (first.kind !== 'proposed-change') throw new Error('first should propose')
    await writeAugmentedConfig(configPath, first.newCode)

    // Second augment: should detect both mutations are already present.
    const second = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    expect(second.kind).toBe('already-configured')
  })

  it('preserves a pre-existing noydb: key rather than clobbering it', async () => {
    // A user who has already set noydb with custom options shouldn't
    // have them overwritten. The augment path treats the key as
    // opaque and skips it.
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: [],\n  noydb: { adapter: 'file', pinia: false },\n})\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    // Custom adapter is preserved (still "file"), not overwritten to "browser".
    expect(r.newCode).toContain("adapter: 'file'")
    expect(r.newCode).toContain('pinia: false')
    // But the module IS added (that half is still missing).
    expect(r.newCode).toContain('@noy-db/in-nuxt')
  })

  it('emits a unified diff with add/remove markers', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: [],\n})\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    // The diff should contain at least one `+` line (the added
    // @noy-db/nuxt module and the new noydb key).
    const addedLines = r.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(addedLines.length).toBeGreaterThan(0)
    expect(addedLines.some((l) => l.includes('@noy-db/in-nuxt'))).toBe(true)
  })

  it('dryRun flag is reflected in the result', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({ modules: [] })\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser', dryRun: true })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    expect(r.dryRun).toBe(true)
    // The file on disk is UNCHANGED — dryRun doesn't write.
    const current = await fs.readFile(configPath, 'utf8')
    expect(current).not.toContain('@noy-db/in-nuxt')
  })

  it('handles a plain object literal export (no defineNuxtConfig wrapper)', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default {\n  modules: [],\n}\n`,
    )
    const r = await augmentNuxtConfig({ configPath, adapter: 'browser' })
    if (r.kind !== 'proposed-change') throw new Error('wrong kind')
    expect(r.newCode).toContain('@noy-db/in-nuxt')
  })
})

// ─── runWizard augment-mode integration ────────────────────────────

describe('runWizard augment mode — integration', () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await rmrf(tmp) })

  it('auto-detects existing Nuxt project and augments the config', async () => {
    // Set up a fake existing Nuxt 4 project.
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({\n  modules: [],\n  devtools: { enabled: true },\n})\n`,
    )
    await writePackageJson(tmp, {
      name: 'existing-app',
      dependencies: { nuxt: '^4.4.0' },
    })

    const result = await runWizard({
      cwd: tmp,
      yes: true,           // skip prompts
      adapter: 'browser',
    })

    expect(result.kind).toBe('augment')
    if (result.kind !== 'augment') throw new Error('wrong kind')
    expect(result.reason).toBe('written')
    expect(result.changed).toBe(true)

    // Verify the file on disk was updated.
    const updated = await fs.readFile(configPath, 'utf8')
    expect(updated).toContain('@noy-db/in-nuxt')
    expect(updated).toContain("adapter: 'browser'")
    // Original unrelated keys should still be present.
    expect(updated).toContain('devtools')
  })

  it('dryRun leaves the file untouched', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({ modules: [] })\n`,
    )
    await writePackageJson(tmp, {
      name: 'existing-app',
      dependencies: { nuxt: '^4.4.0' },
    })

    const original = await fs.readFile(configPath, 'utf8')

    const result = await runWizard({
      cwd: tmp,
      yes: true,
      dryRun: true,
      adapter: 'browser',
    })

    if (result.kind !== 'augment') throw new Error('wrong kind')
    expect(result.reason).toBe('dry-run')
    expect(result.changed).toBe(false)
    expect(result.diff).toBeDefined()

    // File on disk is IDENTICAL to the original.
    const after = await fs.readFile(configPath, 'utf8')
    expect(after).toBe(original)
  })

  it('reports already-configured on a second run', async () => {
    const configPath = await writeConfig(
      tmp,
      `export default defineNuxtConfig({ modules: [] })\n`,
    )
    await writePackageJson(tmp, {
      name: 'existing-app',
      dependencies: { nuxt: '^4.4.0' },
    })

    // First run: writes the config.
    await runWizard({ cwd: tmp, yes: true, adapter: 'browser' })

    // Second run: should be idempotent.
    const second = await runWizard({ cwd: tmp, yes: true, adapter: 'browser' })
    if (second.kind !== 'augment') throw new Error('wrong kind')
    expect(second.reason).toBe('already-configured')
    expect(second.changed).toBe(false)

    // File is STILL valid — not duplicated.
    const content = await fs.readFile(configPath, 'utf8')
    const occurrences = content.split('@noy-db/in-nuxt').length - 1
    expect(occurrences).toBe(1)
  })

  it('forceFresh skips detection even when cwd is a Nuxt project', async () => {
    // Set up a detected project.
    await writeConfig(tmp, `export default defineNuxtConfig({})\n`)
    await writePackageJson(tmp, {
      name: 'existing-app',
      dependencies: { nuxt: '^4.4.0' },
    })

    // forceFresh: true should route to fresh mode and create a
    // subdirectory.
    const result = await runWizard({
      cwd: tmp,
      yes: true,
      forceFresh: true,
      projectName: 'new-sub-app',
      adapter: 'memory',
      sampleData: false,
    })

    expect(result.kind).toBe('fresh')
    if (result.kind !== 'fresh') throw new Error('wrong kind')
    expect(result.projectPath).toBe(path.join(tmp, 'new-sub-app'))
    // The new subdirectory has its own package.json.
    const newPkg = await fs.readFile(
      path.join(result.projectPath, 'package.json'),
      'utf8',
    )
    expect(newPkg).toContain('new-sub-app')
  })

  it('fresh mode returns kind: "fresh" for empty directories (regression)', async () => {
    // Empty directory — no Nuxt project. Should route to fresh mode
    // even without forceFresh.
    const result = await runWizard({
      cwd: tmp,
      yes: true,
      projectName: 'only-app',
      adapter: 'memory',
    })
    expect(result.kind).toBe('fresh')
  })
})
