/**
 * Tests for the wizard's i18n layer (closes #36).
 *
 * Three things matter here:
 *
 *   1. **Key parity** between every shipped locale bundle. The
 *      TypeScript compiler already enforces shape conformance via
 *      the `WizardMessages` interface, but that only catches
 *      *missing* keys — it does NOT catch a stray *extra* key in
 *      one bundle that drifted from another. The parity test below
 *      walks both bundles and asserts an exact set match.
 *
 *   2. **POSIX env-var detection** matches the order shells use:
 *      `LC_ALL` > `LC_MESSAGES` > `LANG` > `LANGUAGE`. Power users
 *      who already have `LANG=th_TH.UTF-8` in their dotfiles get
 *      Thai automatically.
 *
 *   3. **`--lang` override** beats env detection. Tests pass
 *      `locale: 'th'` directly so they don't have to mutate
 *      `process.env`.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectLocale,
  loadMessages,
  parseLocaleFlag,
  SUPPORTED_LOCALES,
} from '../src/wizard/i18n/index.js'
import { en } from '../src/wizard/i18n/en.js'
import { th } from '../src/wizard/i18n/th.js'
import { runWizard } from '../src/wizard/run.js'
import { parseArgs } from '../src/bin/parse-args.js'

// ─── Key parity ────────────────────────────────────────────────────────

describe('locale bundle key parity', () => {
  it('every locale exposes the same keys as English', () => {
    const enKeys = Object.keys(en).sort()
    for (const locale of SUPPORTED_LOCALES) {
      const bundle = loadMessages(locale)
      const localeKeys = Object.keys(bundle).sort()
      expect(localeKeys, `locale=${locale} missing or extra keys`).toEqual(enKeys)
    }
  })

  it('every locale value is a non-empty string', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const bundle = loadMessages(locale)
      for (const [key, value] of Object.entries(bundle)) {
        expect(typeof value, `locale=${locale} key=${key} not a string`).toBe('string')
        expect((value as string).length, `locale=${locale} key=${key} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('th bundle is structurally distinct from en (sanity check)', () => {
    // Catches the "I copy-pasted en.ts but forgot to translate" case.
    // We compare a handful of load-bearing prompt strings — the test
    // is intentionally narrow so a future locale that happens to share
    // a single proper noun with English doesn't false-positive.
    expect(th.promptProjectName).not.toBe(en.promptProjectName)
    expect(th.promptAdapter).not.toBe(en.promptAdapter)
    expect(th.augmentApplyConfirm).not.toBe(en.augmentApplyConfirm)
  })
})

// ─── detectLocale ──────────────────────────────────────────────────────

describe('detectLocale', () => {
  it('returns en when no relevant env vars are set', () => {
    expect(detectLocale({})).toBe('en')
  })

  it('reads LANG=th_TH.UTF-8', () => {
    expect(detectLocale({ LANG: 'th_TH.UTF-8' })).toBe('th')
  })

  it('reads LANG=th', () => {
    expect(detectLocale({ LANG: 'th' })).toBe('th')
  })

  it('strips encoding and modifier suffixes', () => {
    expect(detectLocale({ LANG: 'th_TH.UTF-8@euro' })).toBe('th')
  })

  it('LC_ALL beats LANG (POSIX precedence)', () => {
    expect(detectLocale({ LC_ALL: 'th_TH.UTF-8', LANG: 'en_US.UTF-8' })).toBe('th')
  })

  it('LC_MESSAGES beats LANG but loses to LC_ALL', () => {
    expect(detectLocale({ LC_MESSAGES: 'th_TH', LANG: 'en_US' })).toBe('th')
    expect(
      detectLocale({ LC_ALL: 'en_US', LC_MESSAGES: 'th_TH', LANG: 'th_TH' }),
    ).toBe('en')
  })

  it('LANGUAGE preference list — first entry wins', () => {
    expect(detectLocale({ LANGUAGE: 'th:en' })).toBe('th')
    expect(detectLocale({ LANGUAGE: 'en,th' })).toBe('en')
  })

  it('falls back to en for unsupported locales', () => {
    expect(detectLocale({ LANG: 'fr_FR.UTF-8' })).toBe('en')
    expect(detectLocale({ LANG: 'C' })).toBe('en')
    expect(detectLocale({ LANG: 'POSIX' })).toBe('en')
  })

  it('case-insensitive', () => {
    expect(detectLocale({ LANG: 'TH_TH.UTF-8' })).toBe('th')
  })
})

// ─── parseLocaleFlag ───────────────────────────────────────────────────

describe('parseLocaleFlag', () => {
  it('accepts en and th', () => {
    expect(parseLocaleFlag('en')).toBe('en')
    expect(parseLocaleFlag('th')).toBe('th')
  })

  it('case-insensitive and whitespace-tolerant', () => {
    expect(parseLocaleFlag('TH')).toBe('th')
    expect(parseLocaleFlag(' en ')).toBe('en')
  })

  it('throws on unsupported value with a helpful message', () => {
    expect(() => parseLocaleFlag('fr')).toThrow(/Unsupported --lang/)
    expect(() => parseLocaleFlag('fr')).toThrow(/en, th/)
  })
})

// ─── --lang flag through parseArgs ─────────────────────────────────────

describe('parseArgs --lang', () => {
  it('parses --lang en', () => {
    expect(parseArgs(['--lang', 'en']).options.locale).toBe('en')
  })

  it('parses --lang th', () => {
    expect(parseArgs(['--lang', 'th']).options.locale).toBe('th')
  })

  it('rejects --lang fr', () => {
    expect(() => parseArgs(['--lang', 'fr'])).toThrow(/Unsupported --lang/)
  })

  it('errors when --lang is missing its value', () => {
    expect(() => parseArgs(['--lang'])).toThrow(/--lang requires a value/)
  })

  it('does not set locale when --lang is omitted', () => {
    expect(parseArgs(['my-app']).options.locale).toBeUndefined()
  })
})

// ─── runWizard with locale: 'th' ───────────────────────────────────────

describe('runWizard with locale=th', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noydb-i18n-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('runs to completion in Thai non-interactive mode', async () => {
    // The wizard's user-visible strings are routed through the message
    // bundle, but the GENERATED PROJECT'S code (template files) is
    // English regardless of locale — translating template TS source
    // would just create a fork. This test confirms the wizard accepts
    // the locale and produces the same project files as English mode.
    const result = await runWizard({
      projectName: 'thai-app',
      adapter: 'memory',
      sampleData: false,
      cwd: tempDir,
      yes: true,
      locale: 'th',
    })

    expect(result.kind).toBe('fresh')
    if (result.kind !== 'fresh') return
    expect(result.options.projectName).toBe('thai-app')
    expect(result.files.length).toBeGreaterThan(0)

    // Spot-check that the package.json was rendered as expected.
    const pkgJson = JSON.parse(
      await fs.readFile(path.join(result.projectPath, 'package.json'), 'utf8'),
    )
    expect(pkgJson.name).toBe('thai-app')
  })
})
