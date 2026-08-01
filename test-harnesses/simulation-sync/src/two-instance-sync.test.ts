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
 *  3. concurrent same-record edit — the DEFAULT (`'version'`) strategy's
 *     tie resolves to the later pusher at an ADVANCED version (#936), so
 *     the earlier pusher converges on its next pull; see the test.
 *
 * Keyring note: the sync engine replicates data envelopes, NOT
 * `_keyring` — device B is provisioned by copying the wrapped-keyring
 * envelope at the store boundary before `openVault()` (an instance
 * snapshots the keyring at open; an empty local store would mint a
 * fresh, useless one).
 *
 * Store-identity note: this harness imports hub from `src/`, while the
 * real `toMemory` binds the PUBLISHED `@noy-db/hub/to` seam (dist), so
 * the `ConflictError` a raw `toMemory` throws is a different class
 * identity — the exact dual-copy topology #935 fixed. The engine now
 * matches conflicts identity-safely (`isConflictError`), so the raw
 * store is used directly; this suite is the end-to-end proof.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { withSync } from '../../../packages/hub/src/with-sync/index.js'
import { toMemory } from '../../../packages/to-memory/src/index.js'
import type { Noydb } from '../../../packages/hub/src/index.js'
import type { NoydbStore } from '../../../packages/hub/src/kernel/types.js'

const SECRET = 'simulation-sync-secret-2026'
const VAULT = 'acme'
const USER = 'owner'

interface Doc extends Record<string, unknown> { editor: string; note: string }

describe('simulation: two devices, own local stores, one shared remote', () => {
  let localA: NoydbStore
  let localB: NoydbStore
  let remote: NoydbStore
  let deviceA: Noydb

  beforeEach(async () => {
    localA = toMemory()
    localB = toMemory()
    remote = toMemory()
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

  it('concurrent same-record edit: the later push wins the tie at an ADVANCED version, and the earlier pusher converges (#936)', async () => {
    // ── Default `conflict: 'version'` strategy ──
    // Both devices edit the same v1 record, producing two DIFFERENT v2
    // envelopes. A pushes first (remote ← A@v2). B's push hits the CAS,
    // reports ONE conflict {localVersion: 2, remoteVersion: 2}, and the
    // 'version' tie-break (local >= remote → local) resolves to B — the
    // LAST PUSHER'S edit wins the remote. #936: the winning write is
    // re-stamped at remote._v + 1 and mirrored into B's local store, so
    // A's subsequent pull SEES the advance and adopts B's edit. (The
    // pre-#936 behavior — force-put at the tied _v, A's pull reports 0,
    // devices silently diverged at the same _v — is gone.)
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
    expect(pushB.pushed).toBe(1) // tie resolved to local → B's envelope, advanced

    // The remote holds B's bytes at the ADVANCED version, mirrored locally.
    const remoteEnv = (await remote.get(VAULT, 'docs', 'doc'))!
    const localBEnv = (await localB.get(VAULT, 'docs', 'doc'))!
    expect(remoteEnv._v).toBe(3)
    expect(localBEnv._v).toBe(3)
    expect(remoteEnv._data).toBe(localBEnv._data)

    // A pulls — sees v3 over its v2 and adopts the winner. Converged.
    const pullA = await deviceA.pull(VAULT)
    expect(pullA.pulled).toBe(1)
    expect(await deviceA.vault(VAULT).collection<Doc>('docs').get('doc')).toEqual({ editor: 'B', note: 'from-B' })
    expect(await deviceB.vault(VAULT).collection<Doc>('docs').get('doc')).toEqual({ editor: 'B', note: 'from-B' })
  })
})
