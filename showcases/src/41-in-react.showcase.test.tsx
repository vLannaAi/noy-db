/** @jsxImportSource react */
/**
 * Showcase 41 — in-react (hooks)
 *
 * What you'll learn
 * ─────────────────
 * `<NoydbProvider db={db}>` puts a Noydb instance in React context.
 * `useNoydb()`, `useVault(name)`, `useCollection<T>(vault, name)` are
 * the three hooks consumers reach for — `useCollection` returns
 * `{ records, loading, error }` that re-renders on every collection
 * change.
 *
 * Why it matters
 * ──────────────
 * React is the largest target ecosystem for the package. Hooks-first
 * API matches the 2025 norm.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user.
 *
 * What to read next
 * ─────────────────
 *   - showcase 42-in-nextjs (Next.js cookie session)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-react
 */

import { describe, it, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createNoydb, type Noydb, type Vault } from '@noy-db/hub'
import { NoydbProvider, useCollection } from '@noy-db/in-react'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 41 — in-react', () => {
  it('useCollection inside <NoydbProvider> hydrates and re-renders on put', async () => {
    const db: Noydb = await createNoydb({ store: memory(), user: 'alice', secret: 'in-react-pass-2026' })
    const vault: Vault = await db.openVault('demo')
    const coll = vault.collection<Note>('notes')
    await coll.put('a', { id: 'a', text: 'seed' })

    let lastData: readonly Note[] = []
    function Probe(): JSX.Element {
      const { data } = useCollection<Note>(vault, 'notes')
      lastData = data
      return <ul>{data.map((r) => <li key={r.id}>{r.text}</li>)}</ul>
    }

    render(<NoydbProvider db={db}><Probe /></NoydbProvider>)

    await waitFor(() => expect(lastData.map((r) => r.id)).toEqual(['a']))

    await coll.put('b', { id: 'b', text: 'second' })

    await waitFor(() => expect(lastData.map((r) => r.id).sort()).toEqual(['a', 'b']))
    db.close()
  })
})
