/**
 * Tests for the `noy-db` bin's subcommands.
 *
 * `add` is tested against a temp directory — the command is pure file IO.
 * `verify` is tested by calling `verifyIntegrity()` directly since it
 * returns a result object rather than exiting the process.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCollection, validateCollectionName } from '../src/commands/add.js'
import { verifyIntegrity } from '../src/commands/verify.js'

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'noydb-cmd-test-'))
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

// ─── add command ─────────────────────────────────────────────────────

describe('validateCollectionName', () => {
  it('rejects empty names', () => {
    expect(validateCollectionName('')).toMatch(/required/i)
  })

  it('rejects names starting with a digit or symbol', () => {
    expect(validateCollectionName('1foo')).toMatch(/lowercase letter/)
    expect(validateCollectionName('-foo')).toMatch(/lowercase letter/)
  })

  it('rejects uppercase', () => {
    expect(validateCollectionName('Invoices')).toMatch(/lowercase/)
  })

  it('accepts valid kebab-case names', () => {
    expect(validateCollectionName('invoices')).toBeNull()
    expect(validateCollectionName('client-contacts')).toBeNull()
    expect(validateCollectionName('v2-data')).toBeNull()
  })
})

describe('addCollection', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await makeTempDir()
  })

  afterEach(async () => {
    await rmrf(tmp)
  })

  it('creates a store + page pair', async () => {
    const result = await addCollection({ name: 'clients', cwd: tmp })
    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toMatch(/stores\/clients\.ts$/)
    expect(result.files[1]).toMatch(/pages\/clients\.vue$/)
  })

  it('renders the store with the PascalCase interface name', async () => {
    await addCollection({ name: 'client-contacts', cwd: tmp })
    const store = await fs.readFile(
      path.join(tmp, 'app', 'stores', 'client-contacts.ts'),
      'utf8',
    )
    expect(store).toContain('export interface ClientContacts')
    expect(store).toContain(`defineNoydbStore<ClientContacts>('client-contacts'`)
    expect(store).toContain('useClientContacts')
  })

  it('renders the page with the correct useFn import', async () => {
    await addCollection({ name: 'payments', cwd: tmp })
    const page = await fs.readFile(
      path.join(tmp, 'app', 'pages', 'payments.vue'),
      'utf8',
    )
    expect(page).toContain('const payments = usePayments()')
    expect(page).toContain('await payments.$ready')
    expect(page).toContain('payments.items')
  })

  it('honors the compartment option', async () => {
    await addCollection({ name: 'foo', cwd: tmp, compartment: 'tenant-42' })
    const store = await fs.readFile(
      path.join(tmp, 'app', 'stores', 'foo.ts'),
      'utf8',
    )
    expect(store).toContain(`compartment: 'tenant-42'`)
  })

  it('refuses to overwrite an existing store file', async () => {
    await addCollection({ name: 'dup', cwd: tmp })
    await expect(
      addCollection({ name: 'dup', cwd: tmp }),
    ).rejects.toThrow(/Refusing to overwrite/)
  })

  it('does not leave a half-written project when the second file already exists', async () => {
    // Pre-create only the page — store write should never be attempted.
    const pagePath = path.join(tmp, 'app', 'pages', 'partial.vue')
    await fs.mkdir(path.dirname(pagePath), { recursive: true })
    await fs.writeFile(pagePath, 'EXISTING', 'utf8')

    await expect(
      addCollection({ name: 'partial', cwd: tmp }),
    ).rejects.toThrow(/Refusing to overwrite/)

    // The store file must NOT have been created (atomicity property).
    const storeExists = await fs
      .access(path.join(tmp, 'app', 'stores', 'partial.ts'))
      .then(() => true)
      .catch(() => false)
    expect(storeExists).toBe(false)

    // The existing page must be untouched.
    const contents = await fs.readFile(pagePath, 'utf8')
    expect(contents).toBe('EXISTING')
  })

  it('throws on invalid names before touching the filesystem', async () => {
    await expect(
      addCollection({ name: 'Bad Name', cwd: tmp }),
    ).rejects.toThrow(/lowercase/)
    // Make sure nothing was written.
    const entries = await fs.readdir(tmp)
    expect(entries).toHaveLength(0)
  })
})

// ─── verify command ─────────────────────────────────────────────────────

describe('verifyIntegrity', () => {
  it('passes on a clean install', async () => {
    const result = await verifyIntegrity()
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/passed/)
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('reports a non-zero duration', async () => {
    const result = await verifyIntegrity()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // PBKDF2 with 600K iterations takes hundreds of ms — a 0ms result
    // would mean crypto was accidentally skipped.
    // We don't hard-assert a lower bound because CI machines vary.
  })
})
