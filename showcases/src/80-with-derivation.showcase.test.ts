/**
 * Showcase 80 — withDerivation (Dim 14)
 *
 * What you'll learn
 * ─────────────────
 * `withDerivation` declares a deterministic, plaintext-only transform
 * from one source collection into N output collections. The hub runs
 * `derive` AFTER DEK unwrap, stamps `_derivedFrom` onto every output,
 * and encrypts the outputs with the same DEK as the source — the store
 * sees only ciphertext on both sides.
 *
 * This showcase walks through the five mechanics:
 *
 *   1. **Eager mode** — source-write triggers derive inline; outputs
 *      land in their declared collections in the same call.
 *   2. **Re-derive on update** — putting the source again recomputes
 *      every output (deterministic = the only stable contract).
 *   3. **`_derivedFrom` stamp** — each output carries an immutable
 *      back-pointer to `{ source, sourceId, sourceVersion, derivedAt,
 *      strategyHash }`. Lives inside the encrypted payload, so the
 *      derivation graph is not visible to the storage backend.
 *   4. **`vault.deriveAll`** — bulk recompute escape hatch for when a
 *      strategy changes or a source collection is imported.
 *   5. **Strict-mode rollback** — `strict: true` + `withTransactions`
 *      causes a failing `derive` to roll back the source write. The
 *      source is gone, the broken output never landed.
 *
 * Why it matters
 * ──────────────
 * A regulated-domain consumer (accounting firm) ingests opaque source
 * documents (PDFs, scans) and needs query-friendly projections (text,
 * page count, OCR result) without ever exposing plaintext to the
 * storage backend. Derivations are the mechanism; the projection
 * policy lives in product code. The hub guarantees the crypto and the
 * lifecycle; the consumer guarantees determinism.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 (basics) + 20 (transactions).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md
 *   - docs/services/derivations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → derivations
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { memory } from '@noy-db/to-memory'

interface Pdf extends Record<string, unknown> {
  id: string
  filename: string
  body: string
}

interface PdfMeta extends Record<string, unknown> {
  len: number
  pages: number
  filename: string
  _derivedFrom?: unknown
}

interface PdfText extends Record<string, unknown> {
  content: string
  _derivedFrom?: unknown
}

const pdfDerivation = withDerivation<Pdf, { meta: PdfMeta; text: PdfText }>({
  source: 'pdfs',
  deterministic: true,
  outputs: {
    meta: { shape: 'record', collection: 'pdf-meta' },
    text: { shape: 'record', collection: 'pdf-text' },
  },
  derive: (pdf) => ({
    meta: {
      len: pdf.body.length,
      pages: Math.ceil(pdf.body.length / 1000),
      filename: pdf.filename,
    },
    text: { content: pdf.body },
  }),
  lifecycle: 'eager',
})

async function open(passphrase: string) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    derivationStrategies: [pdfDerivation],
    txStrategy: withTransactions(),
  })
  const vault = await db.openVault('library')
  return { db, vault }
}

describe('Showcase 80 — withDerivation', () => {
  it('writes derived outputs after source write (eager)', async () => {
    const { vault } = await open('showcase-80-eager-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', {
      id: 'p1',
      filename: 'a.pdf',
      body: 'hello world',
    })
    const meta = await vault.collection<PdfMeta>('pdf-meta').get('p1')
    const text = await vault.collection<PdfText>('pdf-text').get('p1')
    expect(meta?.len).toBe('hello world'.length)
    expect(meta?.filename).toBe('a.pdf')
    expect(text?.content).toBe('hello world')
  })

  it('re-derives on source update', async () => {
    const { vault } = await open('showcase-80-update-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', {
      id: 'p1',
      filename: 'a.pdf',
      body: 'first',
    })
    await vault.collection<Pdf>('pdfs').put('p1', {
      id: 'p1',
      filename: 'a.pdf',
      body: 'second-longer',
    })
    const meta = await vault.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe('second-longer'.length)
  })

  it('stamps _derivedFrom onto every output', async () => {
    const { vault } = await open('showcase-80-meta-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', {
      id: 'p1',
      filename: 'a.pdf',
      body: 'x',
    })
    const meta = await vault
      .collection<PdfMeta & { _derivedFrom: { source: string; sourceId: string } }>('pdf-meta')
      .get('p1')
    expect(meta?._derivedFrom.source).toBe('pdfs')
    expect(meta?._derivedFrom.sourceId).toBe('p1')
  })

  it('vault.deriveAll re-derives every record', async () => {
    const { vault } = await open('showcase-80-deriveall-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', { id: 'p1', filename: 'a.pdf', body: 'a' })
    await vault.collection<Pdf>('pdfs').put('p2', { id: 'p2', filename: 'b.pdf', body: 'bb' })
    const { derived } = await vault.deriveAll('pdfs')
    expect(derived).toBe(2)
  })

  it('strict mode rolls back source on derive failure', async () => {
    const failing = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => {
        throw new Error('mock failure')
      },
      lifecycle: 'eager',
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-80-strict-passphrase-2026',
      derivationStrategies: [failing],
      txStrategy: withTransactions(),
    })
    const vault = await db.openVault('library')
    await expect(
      db.transaction(async (tx) => {
        tx.vault('library').collection<Pdf>('pdfs').put('p1', {
          id: 'p1',
          filename: 'a.pdf',
          body: 'x',
        })
      }),
    ).rejects.toThrow('mock failure')
    expect(await vault.collection('pdfs').get('p1')).toBeNull()
  })
})
