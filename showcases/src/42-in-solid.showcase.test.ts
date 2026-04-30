/**
 * Showcase 42 — in-solid (Signal-based reactivity)
 *
 * What you'll learn
 * ─────────────────
 * `createCollectionSignal<T>(vault, name)` returns a tuple
 * `[records: Accessor<T[]>, loading: Accessor<boolean>]`. Solid's
 * fine-grained reactivity means each accessor only triggers the
 * components that read it — no virtual-DOM diffing.
 *
 * Why it matters
 * ──────────────
 * Solid's signal model gives the most efficient reactive surface for
 * encrypted state — diffing happens at the field level, not the
 * component level.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user.
 *
 * What to read next
 * ─────────────────
 *   - showcase 43-in-zustand (vanilla state-creator factory)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-solid
 */

import { describe, it, expect } from 'vitest'
import { createRoot } from 'solid-js'
import { createNoydb } from '@noy-db/hub'
import { createCollectionSignal } from '@noy-db/in-solid'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 42 — in-solid', () => {
  it('createCollectionSignal starts loading then resolves to records', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-solid-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'seed' })
    await vault.collection<Note>('notes').put('b', { id: 'b', text: 'two' })

    await createRoot(async (dispose) => {
      const [records, loading] = createCollectionSignal<Note>(vault, 'notes')
      expect(loading()).toBe(true)

      // Wait for the async hydration to land in the signals.
      await new Promise((r) => setTimeout(r, 30))

      expect(loading()).toBe(false)
      expect(records().map((r) => r.id).sort()).toEqual(['a', 'b'])

      dispose()
    })
    db.close()
  })
})
