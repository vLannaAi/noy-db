import { createNoydb } from '@noydb/core'
import { browser } from '@noydb/browser'
import { memory } from '@noydb/memory'

// ─── State ─────────────────────────────────────────────────────────────

let ownerDb = null
let opDb = null
let viewerDb = null
let officeDb = null
let homeDb = null
let cloudAdapter = null
let backupJson = null
let invoiceCounter = 0

const COMP = 'C101'
const PREFIX = 'noydb-demo'

// ─── Logging ───────────────────────────────────────────────────────────

const logEl = document.getElementById('log')
const storageEl = document.getElementById('storage-view')
const storageBadge = document.getElementById('storage-badge')
const recordsBadge = document.getElementById('records-badge')

function log(msg, cls = '') {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

function logStep(msg) { log(`\n▸ ${msg}`, 'log-step') }
function logOk(msg) { log(`  ✓ ${msg}`, 'log-success') }
function logErr(msg) { log(`  ✗ ${msg}`, 'log-error') }
function logWarn(msg) { log(`  ⚠ ${msg}`, 'log-warn') }
function logInfo(msg) { log(`  ${msg}`, 'log-info') }
function logData(label, obj) { log(`  ${label}: ${JSON.stringify(obj)}`, 'log-data') }

function updateBadges() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
  storageBadge.textContent = `localStorage: ${keys.length} keys`

  let recordCount = 0
  for (const k of keys) {
    const val = localStorage.getItem(k)
    if (!val) continue
    try {
      const parsed = JSON.parse(val)
      // Obfuscated: check _origCol; non-obfuscated: check key
      const col = parsed._origCol ?? ''
      const isInternal = col.startsWith('_') || k.includes(':_keyring:') || k.includes(':_sync:')
      if (!isInternal) recordCount++
    } catch { /* skip */ }
  }
  recordsBadge.textContent = `${recordCount} records`
}

function showStorage() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).sort()
  if (keys.length === 0) {
    storageEl.innerHTML = '<span class="cipher">No NOYDB data in localStorage</span>'
    return
  }

  let html = ''
  for (const key of keys) {
    const shortKey = key.replace(PREFIX + ':', '')
    const val = localStorage.getItem(key)
    let preview = ''
    let label = shortKey
    try {
      const parsed = JSON.parse(val)
      // Obfuscated format: { _origId, _origCol, _env: { _v, _iv, _data } }
      if (parsed._env) {
        const env = parsed._env
        preview = `{ _v:${env._v}, _iv:"${(env._iv || '').slice(0, 12)}…", _data:"${env._data.slice(0, 24)}…" }`
        label = shortKey
      } else if (parsed._data) {
        preview = `{ _v:${parsed._v}, _iv:"${(parsed._iv || '').slice(0, 12)}…", _data:"${parsed._data.slice(0, 24)}…" }`
      } else {
        preview = val.slice(0, 60) + (val.length > 60 ? '…' : '')
      }
    } catch {
      preview = val.slice(0, 60)
    }
    html += `<div><span class="key">${label}</span>\n  <span class="cipher">${preview}</span></div>\n`
  }
  storageEl.innerHTML = html
}

// ─── Step Navigation ───────────────────────────────────────────────────

const stepBtns = document.querySelectorAll('.step-btn')
stepBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const step = btn.dataset.step
    stepBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.style.display = 'none')
    document.getElementById(`panel-${step}`).style.display = 'block'
  })
})

function markStepDone(n) {
  document.querySelector(`.step-btn[data-step="${n}"]`).classList.add('done')
}

// ─── Step 1: Encrypted CRUD ────────────────────────────────────────────

window.step1_init = async function() {
  logStep('Initializing encrypted store with browser adapter')

  ownerDb = await createNoydb({
    adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
    user: 'owner-niwat',
    secret: 'demo-passphrase-2026',
  })

  const comp = await ownerDb.openCompartment(COMP)
  logOk('Store initialized — owner: owner-niwat')
  logInfo('Adapter: localStorage (encrypted with AES-256-GCM)')
  logInfo('Key derivation: PBKDF2-SHA256 (600,000 iterations)')

  // Seed data
  const invoices = comp.collection('invoices')
  const seedData = [
    { id: 'INV-001', r: { amount: 50000, status: 'draft', client: 'บริษัท XYZ', date: '2026-04-01' } },
    { id: 'INV-002', r: { amount: 125000, status: 'sent', client: 'หจก. สมชาย', date: '2026-03-15' } },
    { id: 'INV-003', r: { amount: 8500, status: 'paid', client: 'ABC Trading', date: '2026-02-28' } },
  ]
  for (const { id, r } of seedData) {
    await invoices.put(id, r)
    logOk(`Created ${id}: ฿${r.amount.toLocaleString()} (${r.status})`)
  }
  invoiceCounter = 3

  showStorage()
  updateBadges()
  logInfo('\nOpen DevTools → Application → Local Storage to see the encrypted data')
}

window.step1_addInvoice = async function() {
  if (!ownerDb) return logErr('Initialize store first')
  invoiceCounter++
  const id = `INV-${String(invoiceCounter).padStart(3, '0')}`
  const amount = Math.floor(Math.random() * 200000) + 5000
  const statuses = ['draft', 'sent', 'paid']
  const clients = ['New Corp Ltd.', 'Thai Digital Co.', 'กรุงเทพ Services', 'Acme Inc.']
  const record = {
    amount,
    status: statuses[Math.floor(Math.random() * statuses.length)],
    client: clients[Math.floor(Math.random() * clients.length)],
    date: new Date().toISOString().slice(0, 10),
  }

  const comp = await ownerDb.openCompartment(COMP)
  await comp.collection('invoices').put(id, record)
  logOk(`Added ${id}: ฿${amount.toLocaleString()} — ${record.client}`)
  showStorage()
  updateBadges()
}

window.step1_listAll = async function() {
  if (!ownerDb) return logErr('Initialize store first')
  const comp = await ownerDb.openCompartment(COMP)
  const all = await comp.collection('invoices').list()
  logStep(`All invoices (${all.length} records)`)
  let total = 0
  for (const inv of all) {
    logData(`  ฿${inv.amount.toLocaleString().padStart(8)}  ${inv.status.padEnd(6)}`, inv.client)
    total += inv.amount
  }
  logInfo(`  Total: ฿${total.toLocaleString()}`)
}

window.step1_query = async function() {
  if (!ownerDb) return logErr('Initialize store first')
  const comp = await ownerDb.openCompartment(COMP)
  const invoices = comp.collection('invoices')
  const drafts = invoices.query(i => i.status === 'draft')
  logStep(`Query: status === 'draft' → ${drafts.length} results`)
  for (const d of drafts) logData('  ', d)
}

window.step1_showStorage = function() {
  logStep('Raw localStorage keys (what the adapter sees):')
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).sort()
  for (const key of keys) {
    const val = localStorage.getItem(key)
    try {
      const parsed = JSON.parse(val)
      if (parsed._data) {
        logWarn(`${key.replace(PREFIX + ':', '')}`)
        logInfo(`  _iv: ${(parsed._iv || '').slice(0, 20)}...`)
        logInfo(`  _data: ${parsed._data.slice(0, 40)}... ← CIPHERTEXT`)
      }
    } catch { /* skip */ }
  }
  showStorage()
}

// ─── Step 2: Multi-User ────────────────────────────────────────────────

window.step2_grant = async function() {
  if (!ownerDb) return logErr('Run Step 1 first')
  logStep('Granting access to users')

  await ownerDb.grant(COMP, {
    userId: 'op-somchai',
    displayName: 'สมชาย (Operator)',
    role: 'operator',
    passphrase: 'somchai-pass',
    permissions: { invoices: 'rw' },
  })
  logOk('Granted op-somchai: operator (invoices: rw)')

  await ownerDb.grant(COMP, {
    userId: 'viewer-audit',
    displayName: 'Auditor',
    role: 'viewer',
    passphrase: 'audit-pass',
  })
  logOk('Granted viewer-audit: viewer (read-only all)')

  // Login as each user
  opDb = await createNoydb({
    adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
    user: 'op-somchai',
    secret: 'somchai-pass',
  })
  viewerDb = await createNoydb({
    adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
    user: 'viewer-audit',
    secret: 'audit-pass',
  })

  logOk('Both users can now login with their passphrases')
  showStorage()
  updateBadges()
}

window.step2_operatorWrite = async function() {
  if (!opDb) return logErr('Grant users first')
  logStep('Operator writes to invoices')
  const comp = await opDb.openCompartment(COMP)
  await comp.collection('invoices').put('INV-OP-001', {
    amount: 42000, status: 'draft', client: 'Operator Client', date: '2026-04-05',
  })
  logOk('Operator created INV-OP-001: ฿42,000')
  showStorage()
  updateBadges()
}

window.step2_viewerRead = async function() {
  if (!viewerDb) return logErr('Grant users first')
  logStep('Viewer reads invoices')
  const comp = await viewerDb.openCompartment(COMP)
  const all = await comp.collection('invoices').list()
  logOk(`Viewer sees ${all.length} invoices (read-only access)`)
  for (const inv of all) {
    logInfo(`  ฿${inv.amount.toLocaleString()} — ${inv.status} — ${inv.client}`)
  }
}

window.step2_viewerWrite = async function() {
  if (!viewerDb) return logErr('Grant users first')
  logStep('Viewer attempts to write...')
  try {
    const comp = await viewerDb.openCompartment(COMP)
    await comp.collection('invoices').put('INV-HACK', {
      amount: 999999, status: 'fraud', client: 'Hacker',
    })
    logErr('This should not happen!')
  } catch (e) {
    logOk(`BLOCKED! ${e.code}: ${e.message}`)
    logInfo('The viewer role cannot write — permission enforced by the crypto layer')
  }
}

window.step2_listUsers = async function() {
  if (!ownerDb) return logErr('Initialize store first')
  logStep('Users with access to C101')
  const users = await ownerDb.listUsers(COMP)
  for (const u of users) {
    const label = u.role === 'owner' ? '👑' : u.role === 'operator' ? '🔧' : '👁'
    logInfo(`  ${label} ${u.userId} — ${u.role} (granted by ${u.grantedBy})`)
  }
  markStepDone(2)
}

// ─── Step 3: Offline → Sync ────────────────────────────────────────────

window.step3_setup = async function() {
  logStep('Setting up two-device sync simulation')
  cloudAdapter = memory()

  officeDb = await createNoydb({
    adapter: memory(), sync: cloudAdapter, user: 'user', encrypt: false,
  })
  homeDb = await createNoydb({
    adapter: memory(), sync: cloudAdapter, user: 'user', encrypt: false,
  })

  await officeDb.openCompartment(COMP)
  await homeDb.openCompartment(COMP)
  logOk('Office device ready (local + cloud sync)')
  logOk('Home device ready (local + cloud sync)')
  logInfo('Cloud adapter: in-memory (simulates DynamoDB)')
}

window.step3_officeWrite = async function() {
  if (!officeDb) return logErr('Setup first')
  const comp = await officeDb.openCompartment(COMP)
  await comp.collection('invoices').put('INV-OFFICE-1', {
    amount: 15000, status: 'draft', from: 'office',
  })
  await comp.collection('invoices').put('INV-OFFICE-2', {
    amount: 28000, status: 'sent', from: 'office',
  })
  logOk('Office created 2 invoices locally')
  logInfo(`Dirty records: ${officeDb.syncStatus(COMP).dirty}`)
}

window.step3_officePush = async function() {
  if (!officeDb) return logErr('Setup first')
  const result = await officeDb.push(COMP)
  logOk(`Office pushed ${result.pushed} records to cloud`)
  logInfo(`Dirty remaining: ${officeDb.syncStatus(COMP).dirty}`)
}

window.step3_homePull = async function() {
  if (!homeDb) return logErr('Setup first')
  const result = await homeDb.pull(COMP)
  logOk(`Home pulled ${result.pulled} records from cloud`)
}

window.step3_homeWrite = async function() {
  if (!homeDb) return logErr('Setup first')
  const comp = await homeDb.openCompartment(COMP)
  await comp.collection('invoices').put('INV-HOME-1', {
    amount: 35000, status: 'draft', from: 'home (offline)',
  })
  logOk('Home created INV-HOME-1 while offline')
  logInfo(`Home dirty records: ${homeDb.syncStatus(COMP).dirty}`)
}

window.step3_homePush = async function() {
  if (!homeDb) return logErr('Setup first')
  const result = await homeDb.push(COMP)
  logOk(`Home pushed ${result.pushed} records to cloud`)
}

window.step3_officePull = async function() {
  if (!officeDb) return logErr('Setup first')
  const result = await officeDb.pull(COMP)
  logOk(`Office pulled ${result.pulled} new records from cloud`)

  const comp = await officeDb.openCompartment(COMP)
  const all = await comp.collection('invoices').list()
  logInfo(`Office now has ${all.length} total invoices (from both devices)`)
  markStepDone(3)
}

// ─── Step 4: Persist & Reload ──────────────────────────────────────────

window.step4_check = async function() {
  logStep('Checking persisted data in localStorage')
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
  if (keys.length === 0) {
    logWarn('No NOYDB data found — run Step 1 first')
    return
  }
  const recordKeys = keys.filter(k => !k.includes(':_keyring:') && !k.includes(':_sync:'))
  logOk(`Found ${recordKeys.length} encrypted records in localStorage`)
  logOk(`Found ${keys.length - recordKeys.length} keyring/meta entries`)
  logInfo('This data survives page reload — try it!')
  showStorage()
  updateBadges()
}

window.step4_add = async function() {
  if (!ownerDb) {
    // Re-open after potential reload
    ownerDb = await createNoydb({
      adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
      user: 'owner-niwat',
      secret: 'demo-passphrase-2026',
    })
  }
  const comp = await ownerDb.openCompartment(COMP)
  const id = `PERSIST-${Date.now()}`
  await comp.collection('invoices').put(id, {
    amount: 99999, status: 'persisted', client: 'Reload Test',
    date: new Date().toISOString(),
  })
  logOk(`Added ${id} — this will survive reload!`)
  showStorage()
  updateBadges()
}

window.step4_verify = async function() {
  logStep('Verifying data after reload')
  try {
    const db = await createNoydb({
      adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
      user: 'owner-niwat',
      secret: 'demo-passphrase-2026',
    })
    const comp = await db.openCompartment(COMP)
    const all = await comp.collection('invoices').list()
    logOk(`Found ${all.length} invoices after reload!`)
    for (const inv of all) {
      logInfo(`  ฿${inv.amount.toLocaleString()} — ${inv.status} — ${inv.client}`)
    }
    ownerDb = db
    markStepDone(4)
  } catch (e) {
    logErr(`Failed: ${e.message}`)
    logInfo('If storage was cleared, run Step 1 first')
  }
}

window.step4_clear = function() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
  keys.forEach(k => localStorage.removeItem(k))
  logWarn(`Cleared ${keys.length} NOYDB keys from localStorage`)
  ownerDb = null
  opDb = null
  viewerDb = null
  showStorage()
  updateBadges()
}

// ─── Step 5: Backup & Restore ──────────────────────────────────────────

window.step5_dump = async function() {
  if (!ownerDb) return logErr('Initialize store first (Step 1)')
  logStep('Creating backup')
  const comp = await ownerDb.openCompartment(COMP)
  backupJson = await comp.dump()
  const size = new Blob([backupJson]).size
  logOk(`Backup created: ${(size / 1024).toFixed(1)} KB`)

  const parsed = JSON.parse(backupJson)
  logInfo(`  Collections: ${Object.keys(parsed.collections).join(', ')}`)
  const recordCount = Object.values(parsed.collections).reduce((n, c) => n + Object.keys(c).length, 0)
  logInfo(`  Records: ${recordCount} (all ciphertext)`)
  logInfo(`  Keyrings: ${Object.keys(parsed.keyrings).length}`)
  logInfo('  Safe to download, email, store on USB')
}

window.step5_download = function() {
  if (!backupJson) return logErr('Create backup first')
  const blob = new Blob([backupJson], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `noydb-backup-${COMP}-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
  logOk('Backup file downloaded')
}

window.step5_clearAndRestore = async function() {
  if (!backupJson) return logErr('Create backup first')

  logStep('Clearing all localStorage and restoring from backup')
  const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
  keys.forEach(k => localStorage.removeItem(k))
  logWarn(`Cleared ${keys.length} keys`)

  ownerDb = await createNoydb({
    adapter: browser({ prefix: PREFIX, backend: 'localStorage', obfuscate: true }),
    user: 'owner-niwat',
    secret: 'demo-passphrase-2026',
  })

  const comp = await ownerDb.openCompartment(COMP)
  await comp.load(backupJson)
  logOk('Backup restored!')
  showStorage()
  updateBadges()
}

window.step5_verify = async function() {
  if (!ownerDb) return logErr('Restore first')
  const comp = await ownerDb.openCompartment(COMP)
  const all = await comp.collection('invoices').list()
  logOk(`Verified: ${all.length} invoices restored from backup`)
  for (const inv of all) {
    logInfo(`  ฿${inv.amount.toLocaleString()} — ${inv.status} — ${inv.client}`)
  }
  markStepDone(5)
}

// ─── Init ──────────────────────────────────────────────────────────────

showStorage()
updateBadges()
log('Welcome to the NOYDB Browser Playground!', 'log-step')
log('Click "Initialize Store" to begin.', 'log-info')
log('')
log('Each step demonstrates a key NOYDB feature.', 'log-info')
log('Watch the Raw Storage panel → all data is ciphertext.', 'log-info')
log('Step 4 tests persistence across page reload.', 'log-info')
