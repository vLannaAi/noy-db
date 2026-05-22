/**
 * Showcase 87 — `noydb describe` audit pipeline
 *
 * What you'll learn
 * ─────────────────
 * Two end-to-end paths for producing a human-readable schema audit:
 *
 *   1. **Programmatic**: open a vault, opt collections into
 *      `persistJsonSchema: true`, call `vault.dumpSchema({ withStats })`
 *      to get a structured `VaultSchemaSnapshot`.
 *
 *   2. **Bundle-mode**: write the vault to a `.noydb` bundle and feed
 *      it to `describeBundle()` (the engine behind `noydb describe`).
 *      Output is YAML or JSON with a `_provenance` header.
 *
 * Why it matters
 * ──────────────
 * For accounting-firm audit handoff: an auditor receives a `.noydb`
 * file plus the firm owner's user + passphrase, runs `noydb describe`,
 * gets a readable shape + counter report without ever loading the
 * data into the production app.
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 00 (hello vault)
 *   - Showcase 79 / 80 / 81+ (guards, derivations, MVs to enrich the dump)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → persisted-json-schema, dump-schema-introspection, cli-describe
 * docs/superpowers/specs/2026-05-22-schema-dump-design.md
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, writeNoydbBundle } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { describeBundle } from '@noy-db/cli'

interface Invoice extends Record<string, unknown> {
  id: string
  client_id: string
  amount: number
  status: 'draft' | 'open' | 'paid'
}

describe('Showcase 87 — noydb describe pipeline', () => {
  it('dumpSchema() surfaces the persisted JSON Schema for opted-in collections', async () => {
    const InvoiceSchema = z.object({
      id: z.string(),
      client_id: z.string(),
      amount: z.number().positive(),
      status: z.enum(['draft', 'open', 'paid']),
    })

    const db = await createNoydb({
      store: memory(),
      user: 'owner@acme.example',
      secret: 'showcase-pass-87-12345',
    })
    const vault = await db.openVault('acme')
    vault.collection<Invoice>('invoices', {
      schema: InvoiceSchema,
      persistJsonSchema: true, // ← the opt-in that puts the schema in _schemas/<col>
    })
    await vault._drainPendingSchemaWrites()

    await vault.collection<Invoice>('invoices').put('inv-001', {
      id: 'inv-001', client_id: 'c1', amount: 5000, status: 'paid',
    })

    const snapshot = await vault.dumpSchema({ withStats: true })

    expect(snapshot.vault).toBe('acme')
    expect(snapshot.collections.invoices?.validator).toEqual({
      kind: 'Zod', source: 'persisted',
    })
    // Persisted JSON Schema fingerprint visible from a future bundle:
    expect(snapshot.collections.invoices?.fields.amount?.type).toBe('number')
    expect(snapshot.collections.invoices?.fields.status?.type).toBe('enum')
    // Counter dimension (no decrypt needed):
    expect(snapshot.collections.invoices?.stats?.records).toBe(1)
    expect(snapshot.collections.invoices?.stats?.bytes).toBeGreaterThan(0)
  })

  it('bundle → describeBundle → YAML / JSON audit output', async () => {
    const InvoiceSchema = z.object({ id: z.string(), amount: z.number() })

    // 1) Build the source vault with a persisted schema.
    const db = await createNoydb({
      store: memory(),
      user: 'owner@acme.example',
      secret: 'showcase-pass-87-12345',
    })
    const vault = await db.openVault('acme')
    vault.collection<{ id: string; amount: number }>('invoices', {
      schema: InvoiceSchema,
      persistJsonSchema: true,
    })
    await vault._drainPendingSchemaWrites()
    await vault.collection<{ id: string; amount: number }>('invoices').put('i1', {
      id: 'i1', amount: 1234,
    })

    // 2) Serialize to a `.noydb` bundle (binary).
    const bundleBytes = await writeNoydbBundle(vault, { compression: 'none' })

    // 3) Write to a tmpfile + describe it as the CLI would.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'noydb-showcase-87-'))
    try {
      const path = join(dir, 'sample.noydb')
      await writeFile(path, bundleBytes)

      // YAML output — the audit handoff format.
      const yaml = await describeBundle({
        bundlePath: path,
        user: 'owner@acme.example',
        passphrase: 'showcase-pass-87-12345',
        format: 'yaml',
        withStats: true,
        schemas: 'none',
        sampleSize: 0,
      })
      expect(yaml).toMatch(/_provenance:/)
      expect(yaml).toMatch(/vault: acme/)
      expect(yaml).toMatch(/invoices:/)
      expect(yaml).toMatch(/records: 1/)

      // JSON output — for tooling pipelines.
      const json = await describeBundle({
        bundlePath: path,
        user: 'owner@acme.example',
        passphrase: 'showcase-pass-87-12345',
        format: 'json',
        withStats: false,
        schemas: 'none',
        sampleSize: 0,
      })
      const parsed = JSON.parse(json) as Record<string, unknown>
      expect(parsed._provenance).toMatchObject({
        generatedBy: expect.stringContaining('noydb describe'),
      })
      expect(parsed.vault).toBe('acme')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
