/**
 * Two-instance sync simulation (#927).
 *
 * Two REAL `Noydb` instances ("devices"), each with its OWN local
 * `toMemory()` store, replicating through one shared remote sync store
 * (`sync: remote, syncStrategy: withSync()`). No hub internals mocked;
 * everything observed at the store boundary or the public API:
 *
 *  1. convergence — A writes + pushes, B pulls and reads the records;
 *  2. bidirectional — B writes back + pushes, A pulls; both sides see
 *     both records;
 *  3. concurrent same-record edit — the pinned-by-observation outcome
 *     of the DEFAULT (`'version'`) conflict strategy, see the comment
 *     in the test.
 *
 * Keyring note: the sync engine replicates data envelopes, NOT
 * `_keyring` — device B is provisioned by copying the wrapped-keyring
 * envelope at the store boundary before `openVault()` (an instance
 * snapshots the keyring at open; an empty local store would mint a
 * fresh, useless one).
 *
 * Store-identity shim: this harness imports hub from `src/`, while the
 * real `toMemory` binds the PUBLISHED `@noy-db/hub/to` seam (dist), so
 * the `ConflictError` a raw `toMemory` throws is a different class from
 * the one the src sync engine `instanceof`-checks. In production hub is
 * a singleton and the identities coincide; `srcIdentity()` restores
 * that topology by re-throwing the store's ConflictError with src
 * identity. Without it the engine misfiles CAS conflicts under
 * `result.errors` instead of resolving them — an artifact of running
 * src against a dist-bound store, not product behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { withSync } from '../../../packages/hub/src/with-sync/index.js'
import { toMemory } from '../../../packages/to-memory/src/index.js'
import { ConflictError } from '../../../packages/hub/src/kernel/errors.js'
import type { Noydb } from '../../../packages/hub/src/index.js'
import type { NoydbStore } from '../../../packages/hub/src/kernel/types.js'

const SECRET = 'simulation-sync-secret-2026'
const VAULT = 'acme'
const USER = 'owner'

interface Doc extends Record<string, unknown> { editor: string; note: string }

/** Re-throw the published-seam ConflictError with src class identity (see header). */
function srcIdentity(store: NoydbStore): NoydbStore {
  return {
    ...store,
    async put(vault, collection, id, envelope, expectedVersion) {
      try {
        return await store.put(vault, collection, id, envelope, expectedVersion)
      } catch (err) {
        if (err instanceof Error && err.constructor.name === 'ConflictError') {
          throw new ConflictError((err as Error & { version: number }).version)
        }
        throw err
      }
    },
  }
}

describe('simulation: two devices, own local stores, one shared remote', () => {
  let localA: NoydbStore
  let localB: NoydbStore
  let remote: NoydbStore
  let deviceA: Noydb

  beforeEach(async () => {
    localA = toMemory()
    localB = toMemory()
    remote = srcIdentity(toMemory())
    deviceA = await createNoydb({ store: localA, sync: remote, user: USER, secret: SECRET, syncStrategy: withSync() })
    await deviceA.openVault(VAULT)
  })

  /** Copy A's wrapped keyring into B's local store, then open device B. */
  async function provisionDeviceB(): Promise<Noydb> {
    const keyringEnv = (await localA.get(VAULT, '_keyring', USER))!
    await localB.put(VAULT, '_keyring', USER, keyringEnv)
    const deviceB = await createNoydb({ store: localB, sync: remote, user: USER, secret: SECRET, syncStrategy: withSync() })
    await deviceB.openVault(VAULT)
    return deviceB
  }

  it('A writes and pushes; B pulls and reads the same records (convergence)', async () => {
    const docsA = deviceA.vault(VAULT).collection<Doc>('docs')
    await docsA.put('doc-1', { editor: 'A', note: 'first' })
    await docsA.put('doc-2', { editor: 'A', note: 'second' })
    expect((await deviceA.push(VAULT)).pushed).toBe(2)

    const deviceB = await provisionDeviceB()
    expect((await deviceB.pull(VAULT)).pulled).toBe(2)

    const docsB = deviceB.vault(VAULT).collection<Doc>('docs')
    expect(await docsB.get('doc-1')).toEqual({ editor: 'A', note: 'first' })
    expect(await docsB.get('doc-2')).toEqual({ editor: 'A', note: 'second' })
  })

  it('B writes back and pushes; A pulls — replication is bidirectional', async () => {
    await deviceA.vault(VAULT).collection<Doc>('docs').put('doc-a', { editor: 'A', note: 'from-a' })
    await deviceA.push(VAULT)
    const deviceB = await provisionDeviceB()
    await deviceB.pull(VAULT)

    await deviceB.vault(VAULT).collection<Doc>('docs').put('doc-b', { editor: 'B', note: 'from-b' })
    expect((await deviceB.push(VAULT)).pushed).toBe(1)
    expect((await deviceA.pull(VAULT)).pulled).toBe(1)

    // Both devices now hold both records.
    expect(await deviceA.vault(VAULT).collection<Doc>('docs').get('doc-b')).toEqual({ editor: 'B', note: 'from-b' })
    expect(await deviceB.vault(VAULT).collection<Doc>('docs').get('doc-a')).toEqual({ editor: 'A', note: 'from-a' })
  })

  it('concurrent same-record edit: the later push wins the remote via the version-tie rule; the earlier pusher cannot see it', async () => {
    // ── Pinned by observation (default `conflict: 'version'` strategy) ──
    // Both devices edit the same v1 record, producing two DIFFERENT v2
    // envelopes. A pushes first (remote ← A@v2). B's push hits the CAS,
    // reports ONE conflict {localVersion: 2, remoteVersion: 2}, and the
    // 'version' tie-break (local >= remote → local) force-puts B's
    // envelope — the LAST PUSHER'S edit wins the remote. A's subsequent
    // pull then reports 0 pulled: remote._v equals A's local._v, so the
    // version-based change detection cannot see that the remote CONTENT
    // changed, and A keeps its own edit. The devices stay diverged at
    // the same _v until a later write bumps one of them past the other.
    // This is what the engine actually does — asserted, not endorsed.
    await deviceA.vault(VAULT).collection<Doc>('docs').put('doc', { editor: 'seed', note: 'v1' })
    await deviceA.push(VAULT)
    const deviceB = await provisionDeviceB()
    await deviceB.pull(VAULT)

    await deviceA.vault(VAULT).collection<Doc>('docs').put('doc', { editor: 'A', note: 'from-A' })
    await deviceB.vault(VAULT).collection<Doc>('docs').put('doc', { editor: 'B', note: 'from-B' })

    const pushA = await deviceA.push(VAULT)
    expect(pushA.pushed).toBe(1)
    expect(pushA.conflicts).toHaveLength(0)

    const pushB = await deviceB.push(VAULT)
    expect(pushB.errors).toHaveLength(0)
    expect(pushB.conflicts).toHaveLength(1)
    expect(pushB.conflicts[0]).toMatchObject({ collection: 'docs', id: 'doc', localVersion: 2, remoteVersion: 2 })
    expect(pushB.pushed).toBe(1) // tie resolved to local → B's envelope force-put

    // The remote now holds B's envelope byte-for-byte.
    const remoteEnv = (await remote.get(VAULT, 'docs', 'doc'))!
    const localBEnv = (await localB.get(VAULT, 'docs', 'doc'))!
    expect(remoteEnv._v).toBe(2)
    expect(remoteEnv._data).toBe(localBEnv._data)

    // A pulls — and detects nothing: same _v, different content.
    const pullA = await deviceA.pull(VAULT)
    expect(pullA.pulled).toBe(0)
    expect(pullA.conflicts).toHaveLength(0)
    expect(await deviceA.vault(VAULT).collection<Doc>('docs').get('doc')).toEqual({ editor: 'A', note: 'from-A' })
    expect(await deviceB.vault(VAULT).collection<Doc>('docs').get('doc')).toEqual({ editor: 'B', note: 'from-B' })
  })
})
