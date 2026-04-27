/**
 * Showcase 49 — by-tabs (BroadcastChannel multi-tab transport)
 *
 * What you'll learn
 * ─────────────────
 * `tabsChannel({ name })` returns a `PeerChannel` wrapping the browser's
 * `BroadcastChannel`. Pair two of them on the same name and you have
 * tab-to-tab transport with sub-millisecond latency. The channel
 * implements the same contract as the WebRTC `PeerChannel` from
 * `@noy-db/by-peer`, so it composes with `peerStore()` /
 * `servePeerStore()` exactly the same way.
 *
 * Why it matters
 * ──────────────
 * "Three tabs of the same dashboard" is the most common multi-realm
 * topology a browser-side noy-db app meets. `BroadcastChannel` is the
 * native browser primitive for fan-out; this transport keeps the
 * encryption boundary intact while adding zero round-trips through
 * the storage backend.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 15-with-sync (sync engine basics).
 *
 * What to read next
 * ─────────────────
 *   - docs/packages/by-transports.md (the full by-* family contract)
 *   - @noy-db/by-peer (companion WebRTC transport)
 *
 * Spec mapping
 * ────────────
 * features.yaml → transports → by-tabs
 *
 * Note: this showcase runs in happy-dom which ships `BroadcastChannel`,
 * so the channel works exactly as it would in a real browser.
 */

import { describe, it, expect } from 'vitest'
import { tabsChannel, isTabsChannelAvailable } from '@noy-db/by-tabs'

describe('Showcase 49 — by-tabs', () => {
  it('isTabsChannelAvailable is the pre-flight every UI should run', () => {
    expect(isTabsChannelAvailable()).toBe(true)
  })

  it('two tabs on the same name see each other\'s messages', async () => {
    // Tab A and Tab B simulated as two channels on the same name.
    const tabA = tabsChannel({ name: 'noy-db:vault-acme' })
    const tabB = tabsChannel({ name: 'noy-db:vault-acme' })

    const tabBSaw: string[] = []
    tabB.on('message', (msg) => tabBSaw.push(msg))

    tabA.send('record-id-1-changed')
    tabA.send('record-id-2-deleted')

    await new Promise((r) => setTimeout(r, 20))

    expect(tabBSaw).toEqual(['record-id-1-changed', 'record-id-2-deleted'])

    tabA.close()
    tabB.close()
  })

  it('different vault names are isolated', async () => {
    // A user with two vaults open in separate tabs — each gets its
    // own channel name; messages from one don't leak to the other.
    const acme = tabsChannel({ name: 'noy-db:vault-acme' })
    const personal = tabsChannel({ name: 'noy-db:vault-personal' })

    const personalSaw: string[] = []
    personal.on('message', (msg) => personalSaw.push(msg))

    acme.send('change-on-acme-only')
    await new Promise((r) => setTimeout(r, 20))

    expect(personalSaw).toEqual([])

    acme.close()
    personal.close()
  })
})
