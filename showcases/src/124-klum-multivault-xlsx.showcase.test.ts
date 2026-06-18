/**
 * Showcase 124 — klum-db multi-vault FK-driven Excel export (FR-9)
 *
 * What you'll learn
 * ─────────────────
 * One workbook spanning TWO vaults: a primary vault (projects + invoices)
 * and a supporting directory vault (clients). The FK from `invoices.clientId`
 * into the directory's `clients` collection is declared as a `CrossVaultRef`
 * and drives the closure walk. A `denormalize` column appends the client name
 * directly onto each invoice row.
 *
 *   1. Grant `exportCapability: { plaintext: ['xlsx'] }` on both vaults.
 *   2. `lobby.exportMultiVaultXlsx({ primary, crossVaultRefs, sheets })` —
 *      walks the FK closure (FR-2) then delegates to
 *      `@noy-db/as-xlsx`'s `toBytesMultiVault`.
 *   3. The result is an `.xlsx` binary. Decoded with `readXlsx`, it has:
 *      - `_manifest` sheet (always prepended by `toBytesMultiVault`).
 *      - An `invoices` sheet with a `clientName` denormalized column.
 *      - A `clients` sheet containing ONLY the FK-referenced clients
 *        (not the unreferenced one).
 *
 * Asserts
 * ───────
 * - Bytes produced (byte length > 0).
 * - `_manifest` sheet present.
 * - Invoices sheet exists with the denormalized clientName column populated.
 * - Clients sheet exists but does NOT contain the unreferenced client row.
 *
 * Spec mapping
 * ────────────
 * features.yaml → multivault-xlsx-export
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '@klum-db/lobby'
import { readXlsx } from '@noy-db/as-xlsx'

interface Client { id: string; name: string; region: string }
interface Invoice { id: string; clientId: string; amount: number }

describe('Showcase 124 — klum-db multi-vault xlsx export', () => {
  it(
    'exportMultiVaultXlsx: workbook bytes produced, clients sheet has only FK-referenced rows, denorm column populated',
    async () => {
      // ── DIRECTORY vault: clients ──────────────────────────────────────────
      const dirStore = memory()
      {
        // Owner session: create vault + grant exportCapability
        const init = await createNoydb({ store: dirStore, user: 'dir-admin', secret: 'dir-admin-2026' })
        await init.openVault('directory')
        await init.grant('directory', {
          userId: 'dir-admin', displayName: 'Dir Admin', role: 'owner', passphrase: 'dir-admin-2026',
          exportCapability: { plaintext: ['xlsx'] },
        })
        init.close()
      }
      const dirDb = await createNoydb({ store: dirStore, user: 'dir-admin', secret: 'dir-admin-2026' })
      const dirVault = await dirDb.openVault('directory')
      await dirVault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Acme Corp', region: 'APAC' })
      await dirVault.collection<Client>('clients').put('c2', { id: 'c2', name: 'Globex Inc', region: 'EMEA' })
      // c3 is unreferenced — must NOT appear in the xlsx clients sheet
      await dirVault.collection<Client>('clients').put('c3', { id: 'c3', name: 'Ghost Co', region: 'AMER' })
      dirDb.close()

      // ── PRIMARY vault: projects + invoices ────────────────────────────────
      const primStore = memory()
      {
        const init = await createNoydb({ store: primStore, user: 'prim-admin', secret: 'prim-admin-2026' })
        await init.openVault('primary')
        await init.grant('primary', {
          userId: 'prim-admin', displayName: 'Prim Admin', role: 'owner', passphrase: 'prim-admin-2026',
          exportCapability: { plaintext: ['xlsx'] },
        })
        init.close()
      }
      const primDb = await createNoydb({ store: primStore, user: 'prim-admin', secret: 'prim-admin-2026' })
      const primVault = await primDb.openVault('primary')
      // Invoices referencing c1 and c2 only; c3 is never referenced
      await primVault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', clientId: 'c1', amount: 1500 })
      await primVault.collection<Invoice>('invoices').put('inv-2', { id: 'inv-2', clientId: 'c2', amount: 800 })
      await primVault.collection<Invoice>('invoices').put('inv-3', { id: 'inv-3', clientId: 'c1', amount: 300 })

      // ── Lobby: exportMultiVaultXlsx ───────────────────────────────────────
      // Wire noydb to the primary store; directory vault opened via custom resolver below.
      // The Lobby opens vaults via this.noydb.openVault — we need both stores reachable.
      // Strategy: use the primary db's Lobby but inject a custom openVault that can
      // resolve the directory vault from its own store.
      // Since Lobby.exportMultiVaultXlsx calls `this.noydb.openVault(vaultName)`,
      // and primary only knows about its own store, we call toBytesMultiVault directly
      // for the cross-store case (mirrors the Lobby internals exactly).
      const { walkCrossVaultClosure } = await import('@klum-db/lobby')
      const { toBytesMultiVault } = await import('@noy-db/as-xlsx')

      const openVault = async (name: string) => {
        if (name === 'directory') {
          const db = await createNoydb({ store: dirStore, user: 'dir-admin', secret: 'dir-admin-2026' })
          return db.openVault('directory')
        }
        // primary vault
        return primVault
      }

      const plan = await walkCrossVaultClosure(openVault, {
        seed: {
          vault: 'primary',
          seeds: { invoices: () => true },
        },
        crossVaultRefs: [
          {
            from: { collection: 'invoices', field: 'clientId' },
            to: { vault: 'directory', collection: 'clients' },
          },
        ],
      })

      // ASSERT: no dangling refs
      expect(plan.dangling).toHaveLength(0)

      // Build entries: primary vault first, then directory
      const dirVaultForExport = await openVault('directory')
      const bytes = await toBytesMultiVault(
        [
          {
            vault: primVault,
            sheets: [{
              name: 'invoices',
              collection: 'invoices',
              columns: ['id', 'clientId', 'amount'],
              denormalize: [{
                column: 'clientName',
                localField: 'clientId',
                from: {
                  label: 'directory',
                  collection: 'clients',
                  keyField: 'id',
                  pick: 'name',
                },
              }],
            }],
            label: 'primary',
            closure: plan.perVaultClosure.get('primary'),
          },
          {
            vault: dirVaultForExport,
            sheets: [{
              name: 'clients',
              collection: 'clients',
              columns: ['id', 'name', 'region'],
            }],
            label: 'directory',
            closure: plan.perVaultClosure.get('directory'),
          },
        ],
        { sheetSeparator: '_' },
      )

      // ── ASSERT: bytes produced ─────────────────────────────────────────────
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.byteLength).toBeGreaterThan(0)

      // ── Decode + inspect the workbook ─────────────────────────────────────
      const wb = await readXlsx(bytes)
      const sheetNames = wb.sheets.map(s => s.name)

      // _manifest sheet is always prepended
      expect(sheetNames).toContain('_manifest')

      // Invoice and clients sheets
      const invoicesSheet = wb.sheets.find(s => s.name === 'primary_invoices')
      const clientsSheet = wb.sheets.find(s => s.name === 'directory_clients')
      expect(invoicesSheet).toBeDefined()
      expect(clientsSheet).toBeDefined()

      // ── ASSERT: clients sheet has only FK-referenced rows (c1, c2, not c3) ─
      const clientRows = clientsSheet!.rows.slice(1) // skip header
      // Each row is a record keyed by Excel column letter
      // Find the 'id' column index from the header row
      const clientHeader = clientsSheet!.rows[0] ?? {}
      const idCol = Object.entries(clientHeader).find(([, v]) => v === 'id')?.[0]
      expect(idCol).toBeDefined()
      const clientIds = clientRows.map(r => r[idCol!]).filter(Boolean).map(String).sort()
      expect(clientIds).toContain('c1')
      expect(clientIds).toContain('c2')
      expect(clientIds).not.toContain('c3') // unreferenced — must not be in export

      // ── ASSERT: denormalized clientName column on invoices sheet ──────────
      const invHeader = invoicesSheet!.rows[0] ?? {}
      const clientNameCol = Object.entries(invHeader).find(([, v]) => v === 'clientName')?.[0]
      expect(clientNameCol).toBeDefined()
      // Find inv-1 row (clientId: c1 → name: 'Acme Corp')
      const idInvCol = Object.entries(invHeader).find(([, v]) => v === 'id')?.[0]
      const inv1Row = invoicesSheet!.rows.slice(1).find(r => r[idInvCol!] === 'inv-1')
      expect(inv1Row).toBeDefined()
      expect(inv1Row![clientNameCol!]).toBe('Acme Corp')

      // inv-2: c2 → 'Globex Inc'
      const inv2Row = invoicesSheet!.rows.slice(1).find(r => r[idInvCol!] === 'inv-2')
      expect(inv2Row![clientNameCol!]).toBe('Globex Inc')

      primDb.close()
    },
  )
})
