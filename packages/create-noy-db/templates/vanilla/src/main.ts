/**
 * {{PROJECT_NAME}} — noy-db vanilla starter.
 *
 * A minimal, no-framework integration of noy-db. Everything this file
 * needs to do:
 *
 *   1. Prompt for a passphrase (derives the encryption key).
 *   2. Open an encrypted vault backed by IndexedDB.
 *   3. Render a table of invoices.
 *   4. Let the user add, refresh, and lock.
 *
 * The entire app is ~200 lines — the library does the heavy lifting.
 */

import { createNoydb, type Noydb, type Vault, type Collection } from '@noy-db/hub'
import { browserIdbStore } from '@noy-db/to-browser-idb'
import './style.css'

// ─── Domain type ────────────────────────────────────────────────────

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  issueDate: string // ISO-8601
}

// ─── DOM references ────────────────────────────────────────────────

const statusEl = document.querySelector<HTMLElement>('#status')!
const statusTextEl = document.querySelector<HTMLElement>('.status-text')!
const controlsEl = document.querySelector<HTMLElement>('#controls')!
const invoicesSection = document.querySelector<HTMLElement>('#invoices')!
const invoicesBody = document.querySelector<HTMLTableSectionElement>('#invoices-body')!

const addBtn = document.querySelector<HTMLButtonElement>('#add-invoice')!
const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh')!
const closeBtn = document.querySelector<HTMLButtonElement>('#close-vault')!

// ─── App state ─────────────────────────────────────────────────────

let db: Noydb | null = null
let vault: Vault | null = null
let invoices: Collection<Invoice> | null = null

// ─── Lifecycle ─────────────────────────────────────────────────────

async function unlock() {
  // In a real app you would build a proper modal. For the starter we
  // use the browser prompt — it blocks, it's ugly, and it gets the
  // passphrase in two lines.
  const passphrase = prompt(
    'Enter passphrase for {{PROJECT_NAME}}\n\n' +
      'This derives the master encryption key. Same passphrase every time.\n' +
      'Lose it and the data is unrecoverable (by design).',
  )
  if (!passphrase) {
    showStatus('Cancelled — reload to try again.')
    return
  }

  showStatus('Unlocking vault…')

  db = await createNoydb({
    store: browserIdbStore({ prefix: '{{PROJECT_NAME}}' }),
    user: 'owner',
    secret: passphrase,
  })
  vault = await db.openVault('demo')
  invoices = vault.collection<Invoice>('invoices')

  statusEl.hidden = true
  controlsEl.hidden = false
  invoicesSection.hidden = false
  await render()
}

async function render() {
  if (!invoices) return
  const rows = await invoices.list()
  rows.sort((a, b) => a.issueDate.localeCompare(b.issueDate))

  invoicesBody.innerHTML = ''
  if (rows.length === 0) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td colspan="4" class="empty">No invoices yet — click "Add invoice" to create one.</td>`
    invoicesBody.appendChild(tr)
    return
  }
  for (const inv of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${inv.id}</td>
      <td>${escapeHtml(inv.client)}</td>
      <td>${inv.amount.toLocaleString()}</td>
      <td><span class="status-pill status-${inv.status}">${inv.status}</span></td>
    `
    invoicesBody.appendChild(tr)
  }
}

async function addInvoice() {
  if (!invoices) return
  const client = prompt('Client name?') || 'Unnamed'
  const amountStr = prompt('Amount?') || '0'
  const amount = Number.parseFloat(amountStr)
  if (Number.isNaN(amount)) {
    alert('Amount must be a number.')
    return
  }
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await invoices.put(id, {
    id,
    client,
    amount,
    status: 'draft',
    issueDate: new Date().toISOString().slice(0, 10),
  })
  await render()
}

async function closeVault() {
  if (!db) return
  await db.close()
  db = null
  vault = null
  invoices = null
  controlsEl.hidden = true
  invoicesSection.hidden = true
  showStatus('Vault closed. Reload the page to unlock again.')
}

// ─── Helpers ───────────────────────────────────────────────────────

function showStatus(text: string) {
  statusEl.hidden = false
  statusTextEl.textContent = text
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

// ─── Wire everything up ────────────────────────────────────────────

addBtn.addEventListener('click', () => void addInvoice())
refreshBtn.addEventListener('click', () => void render())
closeBtn.addEventListener('click', () => void closeVault())

window.addEventListener('DOMContentLoaded', () => void unlock())
