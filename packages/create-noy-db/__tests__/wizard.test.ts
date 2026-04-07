/**
 * Wizard tests — cover the pure functions (validation, rendering) and
 * the non-interactive `runWizard({ yes: true, ... })` path. Interactive
 * prompts are tested separately via the argv parser test.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWizard } from '../src/wizard/run.js'
import { validateProjectName } from '../src/wizard/run.js'
import { applyTokens, renderTemplate, templateDir } from '../src/wizard/render.js'

// ─── Helpers ───────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'noydb-wizard-test-'))
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

async function readFile(p: string): Promise<string> {
  return await fs.readFile(p, 'utf8')
}

// ─── validateProjectName ──────────────────────────────────────────────

describe('validateProjectName', () => {
  it('rejects empty names', () => {
    expect(validateProjectName('')).toMatch(/empty/i)
    expect(validateProjectName('   ')).toMatch(/empty/i)
  })

  it('rejects uppercase', () => {
    expect(validateProjectName('MyApp')).toMatch(/lowercase/)
  })

  it('rejects names starting with symbols', () => {
    expect(validateProjectName('-foo')).toMatch(/lowercase letter or digit/)
    expect(validateProjectName('.foo')).toMatch(/lowercase letter or digit/)
    expect(validateProjectName('_foo')).toMatch(/lowercase letter or digit/)
  })

  it('rejects names with spaces or special chars', () => {
    expect(validateProjectName('my app')).toMatch(/lowercase/)
    expect(validateProjectName('my@app')).toMatch(/lowercase/)
  })

  it('rejects names over 214 chars', () => {
    expect(validateProjectName('a'.repeat(215))).toMatch(/214/)
  })

  it('accepts valid names', () => {
    expect(validateProjectName('my-app')).toBeNull()
    expect(validateProjectName('app2')).toBeNull()
    expect(validateProjectName('x')).toBeNull()
    expect(validateProjectName('deeply.scoped.name')).toBeNull()
  })
})

// ─── applyTokens ──────────────────────────────────────────────────────

describe('applyTokens', () => {
  const tokens = {
    PROJECT_NAME: 'demo',
    ADAPTER: 'browser',
    DEVTOOLS: 'true',
    SEED_INVOICES: '[]',
  }

  it('substitutes known tokens', () => {
    expect(applyTokens('name={{PROJECT_NAME}}', tokens)).toBe('name=demo')
  })

  it('substitutes multiple tokens in one string', () => {
    expect(applyTokens('{{PROJECT_NAME}}/{{ADAPTER}}', tokens)).toBe('demo/browser')
  })

  it('leaves unknown tokens alone (easy for template authors to spot)', () => {
    expect(applyTokens('hello {{UNKNOWN}}', tokens)).toBe('hello {{UNKNOWN}}')
  })

  it('handles the empty string', () => {
    expect(applyTokens('', tokens)).toBe('')
  })

  it('does not touch text without tokens', () => {
    expect(applyTokens('no tokens here', tokens)).toBe('no tokens here')
  })
})

// ─── renderTemplate ───────────────────────────────────────────────────

describe('renderTemplate', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await makeTempDir()
  })

  afterEach(async () => {
    await rmrf(tmp)
  })

  it('renders every file from the nuxt-default template with substitutions', async () => {
    const src = templateDir('nuxt-default')
    const files = await renderTemplate(src, tmp, {
      PROJECT_NAME: 'demo-app',
      ADAPTER: 'browser',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[]',
    })

    // Expected file set — sorted, relative to project root.
    expect(files).toEqual([
      '.gitignore',
      'README.md',
      'app/app.vue',
      'app/pages/index.vue',
      'app/pages/invoices.vue',
      'app/stores/invoices.ts',
      'nuxt.config.ts',
      'package.json',
      'tsconfig.json',
    ])
  })

  it('applies tokens to package.json correctly', async () => {
    await renderTemplate(templateDir('nuxt-default'), tmp, {
      PROJECT_NAME: 'my-special-app',
      ADAPTER: 'file',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[]',
    })
    const pkg = JSON.parse(await readFile(path.join(tmp, 'package.json')))
    expect(pkg.name).toBe('my-special-app')
    // package.json has no ADAPTER token — it should ship all adapter deps
    // so users can swap freely. Confirm the renderer didn't accidentally
    // corrupt JSON when there were no substitutions on a field.
    expect(pkg.dependencies['@noy-db/browser']).toBeDefined()
    expect(pkg.dependencies['@noy-db/file']).toBeDefined()
  })

  it('writes the chosen adapter into nuxt.config.ts', async () => {
    await renderTemplate(templateDir('nuxt-default'), tmp, {
      PROJECT_NAME: 'demo',
      ADAPTER: 'memory',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[]',
    })
    const config = await readFile(path.join(tmp, 'nuxt.config.ts'))
    expect(config).toContain(`adapter: 'memory'`)
    expect(config).toContain('devtools: true')
  })

  it('renames _gitignore to .gitignore', async () => {
    await renderTemplate(templateDir('nuxt-default'), tmp, {
      PROJECT_NAME: 'demo',
      ADAPTER: 'browser',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[]',
    })
    // .gitignore exists, _gitignore does not.
    await expect(fs.access(path.join(tmp, '.gitignore'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmp, '_gitignore'))).rejects.toThrow()
  })

  it('handles the empty seed case', async () => {
    await renderTemplate(templateDir('nuxt-default'), tmp, {
      PROJECT_NAME: 'demo',
      ADAPTER: 'browser',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[]',
    })
    const store = await readFile(path.join(tmp, 'app/stores/invoices.ts'))
    expect(store).toContain('DEFAULT_INVOICES: Invoice[] = []')
  })

  it('handles the seeded case', async () => {
    await renderTemplate(templateDir('nuxt-default'), tmp, {
      PROJECT_NAME: 'demo',
      ADAPTER: 'browser',
      DEVTOOLS: 'true',
      SEED_INVOICES: '[\n    { "id": "inv-1", "client": "X" }\n  ]',
    })
    const store = await readFile(path.join(tmp, 'app/stores/invoices.ts'))
    expect(store).toContain('"id": "inv-1"')
    expect(store).toContain('"client": "X"')
  })
})

// ─── runWizard (non-interactive) ──────────────────────────────────────

describe('runWizard — non-interactive', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await makeTempDir()
  })

  afterEach(async () => {
    await rmrf(tmp)
  })

  it('generates a project with all defaults when yes:true', async () => {
    const result = await runWizard({
      yes: true,
      projectName: 'default-app',
      cwd: tmp,
    })

    expect(result.options.projectName).toBe('default-app')
    expect(result.options.adapter).toBe('browser')
    expect(result.options.sampleData).toBe(true)
    expect(result.projectPath).toBe(path.join(tmp, 'default-app'))
    expect(result.files).toContain('package.json')
    expect(result.files).toContain('nuxt.config.ts')
  })

  it('respects explicit adapter and sampleData', async () => {
    const result = await runWizard({
      yes: true,
      projectName: 'file-app',
      adapter: 'file',
      sampleData: false,
      cwd: tmp,
    })
    expect(result.options.adapter).toBe('file')
    expect(result.options.sampleData).toBe(false)
    const store = await readFile(path.join(result.projectPath, 'app/stores/invoices.ts'))
    expect(store).toContain('Invoice[] = []')
  })

  it('generates seed data when sampleData:true', async () => {
    const result = await runWizard({
      yes: true,
      projectName: 'seeded-app',
      sampleData: true,
      cwd: tmp,
    })
    const store = await readFile(path.join(result.projectPath, 'app/stores/invoices.ts'))
    expect(store).toContain('Acme Holdings')
    expect(store).toContain('Globex Inc')
  })

  it('refuses to overwrite an existing non-empty directory', async () => {
    const target = path.join(tmp, 'existing')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'dont-clobber.txt'), 'important')

    await expect(
      runWizard({ yes: true, projectName: 'existing', cwd: tmp }),
    ).rejects.toThrow(/already exists/)

    // Pre-existing file must still be there.
    const untouched = await readFile(path.join(target, 'dont-clobber.txt'))
    expect(untouched).toBe('important')
  })

  it('writes into an empty pre-existing directory happily', async () => {
    const target = path.join(tmp, 'empty')
    await fs.mkdir(target)
    const result = await runWizard({ yes: true, projectName: 'empty', cwd: tmp })
    expect(result.files.length).toBeGreaterThan(0)
  })

  it('generates a package.json whose name matches the project', async () => {
    const result = await runWizard({
      yes: true,
      projectName: 'roundtrip',
      cwd: tmp,
    })
    const pkg = JSON.parse(await readFile(path.join(result.projectPath, 'package.json')))
    expect(pkg.name).toBe('roundtrip')
  })
})
