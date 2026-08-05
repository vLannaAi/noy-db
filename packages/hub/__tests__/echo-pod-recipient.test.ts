/**
 * Echo-mode pod recipients (spec
 * design-history/2026-08-02-echo-secret-design.md, #940, Task 8).
 *
 * A `.noydb` pod slot may carry a structured 3-part echo secret instead of
 * a plain string, so the anti-phishing ceremony (prompt → echo → key)
 * travels with a shared/orphaned pod recipient — not just a live owner
 * keyring. Mirrors the writer→bytes→reader flow of
 * `bundle-recipient-expiry.test.ts` exactly, with an echo-parts recipient.
 */
import { describe, it, expect } from 'vitest'
import type {
  NoydbStore, EncryptedEnvelope, VaultSnapshot, BundleRecipient, KeyringFile,
} from '../src/index.js'
import {
  ConflictError, createNoydb, writePod, readPod,
} from '../src/index.js'
import { EchoCeremonyRequiredError } from '../src/kernel/errors.js'
import { beginEchoUnlock } from '../src/with-party/team/echo-ceremony.js'
import { withHistory } from '../src/with-commit/history/index.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; amount: number }

// Same 3-part shape as echo-e2e.test.ts's PARTS fixture.
const RPARTS = {
  prompt: 'sono il revisore esterno',
  echo: 'con accesso di sola lettura annuale',
  key: 'melograno rosso',
}

async function setupSourceVault() {
  const db = await createNoydb({
    store: toMemory(), user: 'alice', secret: 'source-pw-2026',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
  return { db, vault }
}

/**
 * Restore a pod's bytes into a fresh adapter WITHOUT unlocking as any
 * particular user — same rationale as `bundle-recipients.test.ts`'s
 * `restoreAs`: the bundle's keyrings are sealed under recipient secrets,
 * not under whatever secret a `vault.load()` call would use to re-derive
 * them, so we bypass `load()` and write the pod's keyrings + collections
 * directly to the adapter.
 */
async function restoreBytes(bundleBytes: Uint8Array) {
  const { dumpJson } = await readPod(bundleBytes)
  const dump = JSON.parse(dumpJson) as {
    _compartment: string
    keyrings: Record<string, unknown>
    collections: Record<string, Record<string, EncryptedEnvelope>>
    _internal?: Record<string, Record<string, EncryptedEnvelope>>
  }
  const compartment = dump._compartment
  const targetStore = toMemory()

  for (const [userId, kf] of Object.entries(dump.keyrings)) {
    await targetStore.put(compartment, '_keyring', userId, {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify(kf),
    })
  }
  for (const [collName, records] of Object.entries(dump.collections)) {
    for (const [id, env] of Object.entries(records)) {
      await targetStore.put(compartment, collName, id, env)
    }
  }
  if (dump._internal) {
    for (const [collName, records] of Object.entries(dump._internal)) {
      for (const [id, env] of Object.entries(records)) {
        await targetStore.put(compartment, collName, id, env)
      }
    }
  }

  return { targetStore, compartment }
}

describe('writePod — echo-mode recipients', () => {
  it('recipient enrolled with echo parts opens the pod and reads shared data', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', secret: RPARTS, role: 'viewer' },
    ]
    const bytes = await writePod(vault, { recipients })
    src.close()

    const { targetStore } = await restoreBytes(bytes)
    const reader = await createNoydb({
      store: targetStore, user: 'auditor', secretMode: 'echo', secret: RPARTS,
      historyStrategy: withHistory(),
    })
    const v = await reader.openVault('demo')
    expect(await v.collection<Invoice>('invoices').get('a')).toEqual({ id: 'a', amount: 100 })
    reader.close()
  })

  it('a joined "#"-separated string cannot bypass the ceremony', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', secret: RPARTS, role: 'viewer' },
    ]
    const bytes = await writePod(vault, { recipients })
    src.close()

    const { targetStore } = await restoreBytes(bytes)
    const joined = `${RPARTS.prompt}#${RPARTS.echo}#${RPARTS.key}`
    const reader = await createNoydb({ store: targetStore, user: 'auditor', secret: joined })
    await expect(reader.openVault('demo')).rejects.toThrow(EchoCeremonyRequiredError)
    reader.close()
  })

  it('reveal: "none" stores a recipient keyring with echo.reveal.kind === "none"', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', secret: { ...RPARTS, reveal: 'none' }, role: 'viewer' },
    ]
    const bytes = await writePod(vault, { recipients })
    src.close()

    const { targetStore, compartment } = await restoreBytes(bytes)
    const env = await targetStore.get(compartment, '_keyring', 'auditor')
    const file = JSON.parse(env!._data) as KeyringFile
    expect(file.echo?.reveal.kind).toBe('none')
  })

  it('the interactive ceremony unlocks a restored pod keyring end to end', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', secret: RPARTS, role: 'viewer' },
    ]
    const bytes = await writePod(vault, { recipients })
    src.close()

    const { targetStore, compartment } = await restoreBytes(bytes)
    const ceremony = await beginEchoUnlock(targetStore, compartment, {
      userId: 'auditor', prompt: RPARTS.prompt,
    })
    expect(ceremony.reveal).toBe(RPARTS.echo)
    const unlocked = await ceremony.complete({ key: RPARTS.key })
    expect(unlocked.userId).toBe('auditor')
  })
})
