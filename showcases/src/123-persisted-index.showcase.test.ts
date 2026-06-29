/**
 * Showcase 123 — Persisted lexical index (textIndexPersist) — #308 L1.5
 *
 * What you'll learn
 * ─────────────────
 * `textIndexPersist: true` persists the L1 inverted index as a single **opaque
 * encrypted blob** (`_ftindex/<collection>`) under the collection DEK.  On a
 * fresh `createNoydb` over the **same store**, `retrieve()` cold-loads the blob
 * and returns correct results immediately — no full re-tokenize scan of the
 * collection.
 *
 * The key ideas demonstrated here:
 *
 *   1. **Session 1 — seed + flush**: write records, call `flushIndex()` to
 *      force-persist the index immediately (rather than waiting for the
 *      debounced background flush), then `db.close()`.
 *   2. **Session 2 — warm load**: a fresh `createNoydb` over the SAME store
 *      instance opens the vault, the collection loads the blob, the fingerprint
 *      matches, and `retrieve()` returns correct results — no rebuild needed.
 *   3. **Rank is 1-based and monotonic**: each `RetrieveHit` carries a `rank`
 *      field (1, 2, 3, …) that enables Reciprocal Rank Fusion across vaults in
 *      the klum-db Lobby (L3 federation).
 *   4. **Stale fingerprint → self-healing rebuild**: if records are added in
 *      session 2 before the first retrieve, the fingerprint won't match and
 *      the index rebuilds automatically.
 *
 * Why it matters
 * ──────────────
 * In large corpora or short-lived agent sessions the first-call tokenize scan
 * of the whole collection can be expensive.  `textIndexPersist` turns that
 * cold-start cost into a one-off: subsequent sessions load the blob (one store
 * read) instead of scanning.  The blob is ciphertext under the collection DEK —
 * no terms, postings, or plaintext reach the store (zero added leakage).
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/search.md — full L1.5 documentation
 *   - docs/superpowers/specs/2026-06-22-ai-retrieval-l1.5-persisted-index-design.md
 *   - Showcase 122 — L1 retrieve() walkthrough
 *   - Showcase 111 — L0 scan-mode search
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → search-index
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

// ─── Shared type ─────────────────────────────────────────────────────────────

interface Doc extends Record<string, unknown> {
  id: string
  title: string
  body: string
}

// ─── Part A: warm cross-session cold load ────────────────────────────────────
//
// Session 1 writes records and force-flushes the index.
// Session 2 opens a fresh db over the SAME store and retrieves immediately —
// the fingerprint matches and results are correct.

describe('Showcase 123-A — textIndexPersist: warm cross-session load', () => {
  it('session 2 retrieve() returns correct results from the persisted blob', async () => {
    // The shared store survives across createNoydb calls (test-fixture pattern).
    const store = memory()

    // ── Session 1: seed records + flush ───────────────────────────────────────
    {
      const db = await createNoydb({
        store,
        user: 'analyst',
        secret: 'persist-123-a-passphrase',
      })
      const vault = await db.openVault('firm')
      const docs = vault.collection<Doc>('reports', {
        textIndexes: ['title', 'body'],
        textIndexPersist: true,
      })

      await docs.put('r-1', {
        id: 'r-1',
        title: 'Q1 Financial Overview',
        body: 'Revenue grew by twelve percent in the first quarter.',
      })
      await docs.put('r-2', {
        id: 'r-2',
        title: 'Annual Compliance Report',
        body: 'All regulatory requirements were met without exception.',
      })
      await docs.put('r-3', {
        id: 'r-3',
        title: 'Tax Filing Summary',
        body: 'Estimated tax liability reduced after deduction review.',
      })

      // Force-persist the index now (rather than waiting for debounce).
      await docs.flushIndex()
      db.close()
    }

    // ── Session 2: fresh db, warm load ────────────────────────────────────────
    {
      const db = await createNoydb({
        store,
        user: 'analyst',
        secret: 'persist-123-a-passphrase',
      })
      const vault = await db.openVault('firm')
      const docs = vault.collection<Doc>('reports', {
        textIndexes: ['title', 'body'],
        textIndexPersist: true,
      })

      // retrieve() loads the persisted blob; fingerprint matches → no rebuild.
      const hits = await docs.retrieve('financial')
      expect(hits.length).toBeGreaterThan(0)
      const ids = hits.map((h) => h.id)
      expect(ids).toContain('r-1')

      // Compliance report matches 'regulatory' in the body.
      const complianceHits = await docs.retrieve('regulatory')
      expect(complianceHits.map((h) => h.id)).toContain('r-2')

      // Tax filing matches 'tax'.
      const taxHits = await docs.retrieve('tax')
      expect(taxHits.map((h) => h.id)).toContain('r-3')

      db.close()
    }
  })
})

// ─── Part B: RetrieveHit.rank is 1-based and monotonic ───────────────────────

describe('Showcase 123-B — RetrieveHit.rank: 1-based, monotonic with score', () => {
  it('rank is 1 for the top hit and increases by 1 per position', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'persist-123-b-passphrase',
    })
    const vault = await db.openVault('firm')
    const docs = vault.collection<Doc>('memos', {
      textIndexes: ['title', 'body'],
    })

    await docs.put('m-1', {
      id: 'm-1',
      title: 'Invoice payment overdue notice',
      body: 'The invoice dated March 1 remains unpaid.',
    })
    await docs.put('m-2', {
      id: 'm-2',
      title: 'Payment reminder for invoice',
      body: 'Please settle the outstanding invoice balance.',
    })
    await docs.put('m-3', {
      id: 'm-3',
      title: 'Staff meeting notes',
      body: 'Quarterly review discussion points.',
    })

    const hits = await docs.retrieve('invoice')
    // At least 2 hits (m-1 and m-2 both mention invoice).
    expect(hits.length).toBeGreaterThanOrEqual(2)

    // rank is 1-based: first hit has rank 1.
    expect(hits[0]!.rank).toBe(1)

    // rank is monotonically increasing (1, 2, 3, …).
    for (let i = 0; i < hits.length; i++) {
      expect(hits[i]!.rank).toBe(i + 1)
    }

    // score is non-increasing (best-first ordering).
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score)
    }

    db.close()
  })
})

// ─── Part C: stale fingerprint → self-healing rebuild ────────────────────────
//
// After session 1 flushes the blob, session 2 adds a new record BEFORE calling
// retrieve().  The fingerprint (count, maxVersion) no longer matches the blob,
// so the index is rebuilt and the new record is found.

describe('Showcase 123-C — stale fingerprint: self-healing rebuild', () => {
  it('new record added before first retrieve() is always found (fingerprint mismatch → rebuild)', async () => {
    const store = memory()

    // ── Session 1: two records + flush ────────────────────────────────────────
    {
      const db = await createNoydb({
        store,
        user: 'analyst',
        secret: 'persist-123-c-passphrase',
      })
      const vault = await db.openVault('firm')
      const docs = vault.collection<Doc>('ledger', {
        textIndexes: ['title', 'body'],
        textIndexPersist: true,
      })

      await docs.put('l-1', { id: 'l-1', title: 'Opening balance', body: 'Assets at start of year.' })
      await docs.put('l-2', { id: 'l-2', title: 'Closing balance', body: 'Assets at end of year.' })
      await docs.flushIndex()
      db.close()
    }

    // ── Session 2: add a record, then retrieve ────────────────────────────────
    {
      const db = await createNoydb({
        store,
        user: 'analyst',
        secret: 'persist-123-c-passphrase',
      })
      const vault = await db.openVault('firm')
      const docs = vault.collection<Doc>('ledger', {
        textIndexes: ['title', 'body'],
        textIndexPersist: true,
      })

      // Adding a record before retrieve() bumps count+maxVersion → fingerprint
      // mismatch → index rebuilt from scratch (self-healing).
      await docs.put('l-3', { id: 'l-3', title: 'Adjustment entry', body: 'Depreciation adjustment.' })

      // The newly added record must appear in results.
      const hits = await docs.retrieve('adjustment')
      expect(hits.map((h) => h.id)).toContain('l-3')

      // Previously persisted records are also found.
      const balanceHits = await docs.retrieve('balance')
      const balanceIds = balanceHits.map((h) => h.id)
      expect(balanceIds).toContain('l-1')
      expect(balanceIds).toContain('l-2')

      db.close()
    }
  })
})
