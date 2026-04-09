#!/usr/bin/env node

/**
 * NOYDB Interactive Playground
 *
 * A guided demo that walks you through NOYDB's key features:
 *   1. Encrypted CRUD with file adapter
 *   2. Multi-user access control (owner, operator, viewer)
 *   3. Offline work → online sync
 *   4. Conflict detection and resolution
 *   5. Backup and restore
 *
 * Run: pnpm demo (from playground/ directory)
 *   or: node playground/demo.mjs (from repo root)
 */

import { createNoydb, formatDiff } from '@noy-db/core'
import { memory } from '@noy-db/memory'
import { jsonFile } from '@noy-db/file'
import { createInterface } from 'node:readline'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Helpers ───────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve))
}

const isInteractive = process.stdin.isTTY === true

async function pause(message = 'Press Enter to continue...') {
  if (isInteractive) {
    await ask(`\n  💡 ${message}`)
  } else {
    console.log(`\n  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─`)
  }
}

function banner(title) {
  const line = '═'.repeat(60)
  console.log(`\n\x1b[36m  ╔${line}╗`)
  console.log(`  ║  ${title.padEnd(58)}║`)
  console.log(`  ╚${line}╝\x1b[0m`)
}

function section(title) {
  const pad = Math.max(0, 55 - title.length)
  console.log(`\n\x1b[33m  ── ${title} ${'─'.repeat(pad)}\x1b[0m`)
}

function info(msg) {
  console.log(`\x1b[2m  ${msg}\x1b[0m`)
}

function success(msg) {
  console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`)
}

function warn(msg) {
  console.log(`\x1b[33m  ⚠ ${msg}\x1b[0m`)
}

function error(msg) {
  console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`)
}

function data(label, obj) {
  console.log(`\x1b[34m  ${label}:\x1b[0m`, JSON.stringify(obj, null, 2).split('\n').join('\n  '))
}

function step(n, total, desc) {
  console.log(`\n\x1b[35m  [${n}/${total}] ${desc}\x1b[0m`)
}

// ─── Main Demo ─────────────────────────────────────────────────────────

async function main() {
  console.clear()
  banner('NOYDB — Interactive Playground')
  console.log(`
  Welcome to the NOYDB guided demo!

  NOYDB is a zero-knowledge, offline-first, encrypted document store.
  This demo walks you through the key features using real code.

  \x1b[2mAll data is created in a temp directory and cleaned up after.\x1b[0m
  `)

  const TOTAL_STEPS = 6
  const tempDir = await mkdtemp(join(tmpdir(), 'noydb-demo-'))

  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Encrypted CRUD with File Adapter
    // ═══════════════════════════════════════════════════════════════

    step(1, TOTAL_STEPS, 'Encrypted CRUD with File Adapter')

    info('Creating an encrypted store on the filesystem...')
    info(`Data directory: ${tempDir}`)

    const ownerDb = await createNoydb({
      adapter: jsonFile({ dir: tempDir }),
      user: 'owner-firm',
      secret: 'firm-secure-passphrase-2026',
      history: { enabled: true },
    })
    success('noy-db instance created (owner-firm, encrypted)')

    info('Opening compartment "C101" (company: บริษัท ABC จำกัด)...')
    const company = await ownerDb.openCompartment('C101')
    success('Compartment C101 opened')

    section('Writing invoices')
    const invoices = company.collection('invoices')

    const invoiceData = [
      { id: 'INV-001', record: { amount: 50000, status: 'draft', client: 'บริษัท XYZ', items: 3 } },
      { id: 'INV-002', record: { amount: 125000, status: 'sent', client: 'หจก. สมชาย', items: 7 } },
      { id: 'INV-003', record: { amount: 8500, status: 'paid', client: 'ABC Trading Co.', items: 1 } },
    ]

    for (const { id, record } of invoiceData) {
      await invoices.put(id, record)
      success(`Put ${id}: ฿${record.amount.toLocaleString()} (${record.status})`)
    }

    section('Reading back')
    const inv1 = await invoices.get('INV-001')
    data('INV-001', inv1)

    section('Querying in-memory')
    const drafts = invoices.query(i => i.status === 'draft')
    info(`Drafts: ${drafts.length} found`)
    const largeInvoices = invoices.query(i => i.amount > 10000)
    info(`Invoices > ฿10,000: ${largeInvoices.length} found`)

    section('What the adapter sees (ciphertext on disk)')
    const files = await readdir(join(tempDir, 'C101', 'invoices')).catch(() => [])
    for (const file of files.slice(0, 1)) {
      const content = await readFile(join(tempDir, 'C101', 'invoices', file), 'utf-8')
      const envelope = JSON.parse(content)
      info(`File: ${file}`)
      info(`Version: ${envelope._v}, Timestamp: ${envelope._ts}`)
      info(`IV: ${envelope._iv.slice(0, 20)}...`)
      info(`Data: ${envelope._data.slice(0, 40)}... (ciphertext!)`)
      warn('The adapter ONLY sees encrypted data. Zero knowledge.')
    }

    await pause()

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Multi-User Access Control
    // ═══════════════════════════════════════════════════════════════

    step(2, TOTAL_STEPS, 'Multi-User Access Control')

    info('The owner will now grant access to two users:')
    info('  • Somchai (operator) — can read/write invoices')
    info('  • Auditor (viewer) — can read everything, write nothing')

    section('Granting Somchai (operator)')
    await ownerDb.grant('C101', {
      userId: 'op-somchai',
      displayName: 'สมชาย (Operator)',
      role: 'operator',
      passphrase: 'somchai-pass-2026',
      permissions: { invoices: 'rw' },
    })
    success('Granted op-somchai: operator with invoices:rw')

    section('Granting Auditor (viewer)')
    await ownerDb.grant('C101', {
      userId: 'viewer-audit',
      displayName: 'External Auditor',
      role: 'viewer',
      passphrase: 'audit-readonly-pass',
    })
    success('Granted viewer-audit: viewer (read-only all)')

    section('Listing all users')
    const users = await ownerDb.listUsers('C101')
    for (const u of users) {
      info(`  ${u.userId} — role: ${u.role}, granted by: ${u.grantedBy}`)
    }

    section('Operator login — reading and writing')
    const opDb = await createNoydb({
      adapter: jsonFile({ dir: tempDir }),
      user: 'op-somchai',
      secret: 'somchai-pass-2026',
    })
    const opCompany = await opDb.openCompartment('C101')
    const opInvoices = opCompany.collection('invoices')

    const opRead = await opInvoices.get('INV-001')
    success(`Operator reads INV-001: ฿${opRead.amount.toLocaleString()}`)

    await opInvoices.put('INV-004', { amount: 75000, status: 'draft', client: 'New Client', items: 5 })
    success('Operator created INV-004: ฿75,000')

    section('Viewer login — read-only access')
    const viewerDb = await createNoydb({
      adapter: jsonFile({ dir: tempDir }),
      user: 'viewer-audit',
      secret: 'audit-readonly-pass',
    })
    const viewerCompany = await viewerDb.openCompartment('C101')
    const viewerInvoices = viewerCompany.collection('invoices')

    const viewerRead = await viewerInvoices.list()
    success(`Viewer sees ${viewerRead.length} invoices (read-only)`)

    try {
      await viewerInvoices.put('INV-HACK', { amount: 999999, status: 'fraud', client: 'Hacker', items: 0 })
      error('This should not happen!')
    } catch (e) {
      success(`Viewer blocked from writing: ${e.code} — "${e.message}"`)
    }

    await pause()

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Offline → Online Sync
    // ═══════════════════════════════════════════════════════════════

    step(3, TOTAL_STEPS, 'Offline Work → Online Sync')

    info('Simulating two locations with separate local storage + shared cloud:')
    info('  • Office computer (local-A + cloud)')
    info('  • Home laptop (local-B + cloud)')

    const cloudAdapter = memory() // simulates DynamoDB/S3

    const officeDb = await createNoydb({
      adapter: memory(),
      sync: cloudAdapter,
      user: 'owner',
      encrypt: false, // unencrypted for demo clarity
    })

    const homeDb = await createNoydb({
      adapter: memory(),
      sync: cloudAdapter,
      user: 'owner',
      encrypt: false,
    })

    section('Office: create invoices while online')
    const officeComp = await officeDb.openCompartment('C101')
    const officeInv = officeComp.collection('invoices')
    await officeInv.put('INV-A1', { amount: 10000, status: 'draft', from: 'office' })
    await officeInv.put('INV-A2', { amount: 20000, status: 'sent', from: 'office' })
    success('Office created 2 invoices')

    info('Pushing office changes to cloud...')
    const pushResult = await officeDb.push('C101')
    success(`Pushed ${pushResult.pushed} records to cloud`)

    section('Home: pull from cloud')
    await homeDb.openCompartment('C101')
    const pullResult = await homeDb.pull('C101')
    success(`Home pulled ${pullResult.pulled} records from cloud`)

    section('Home: work offline (create new invoice)')
    const homeComp = await homeDb.openCompartment('C101')
    const homeInv = homeComp.collection('invoices')
    await homeInv.put('INV-B1', { amount: 30000, status: 'draft', from: 'home' })
    success('Home created INV-B1 while offline')

    info('Checking sync status...')
    const homeStatus = homeDb.syncStatus('C101')
    info(`  Dirty records: ${homeStatus.dirty}`)
    info(`  Last pull: ${homeStatus.lastPull}`)

    section('Home: go back online → push')
    const homePush = await homeDb.push('C101')
    success(`Home pushed ${homePush.pushed} records to cloud`)

    section('Office: pull home\'s changes')
    const officePull = await officeDb.pull('C101')
    success(`Office pulled ${officePull.pulled} new records`)

    info('Both locations now have all 3 invoices:')
    const officeAll = await officeInv.list()
    const homeAll = await homeInv.list()
    info(`  Office: ${officeAll.length} invoices`)
    info(`  Home: ${homeAll.length} invoices`)

    await pause()

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Conflict Detection
    // ═══════════════════════════════════════════════════════════════

    step(4, TOTAL_STEPS, 'Conflict Detection & Resolution')

    info('Both office and home edit the same invoice while offline...')

    section('Office edits INV-A1')
    await officeInv.put('INV-A1', { amount: 15000, status: 'sent', from: 'office-updated' })
    success('Office updated INV-A1 to ฿15,000')

    section('Home also edits INV-A1 (different change)')
    await homeInv.put('INV-A1', { amount: 12000, status: 'paid', from: 'home-updated' })
    success('Home updated INV-A1 to ฿12,000')

    section('Office pushes first')
    await officeDb.push('C101')
    success('Office pushed INV-A1 (v3) to cloud')

    section('Home tries to push — conflict!')
    info('Home has INV-A1 at v3, cloud also has v3 (from office)')
    info('Using "version" strategy: higher or equal version wins (local)')

    const conflicts = []
    homeDb.on('sync:conflict', (c) => conflicts.push(c))
    await homeDb.push('C101')

    if (conflicts.length > 0) {
      warn(`Conflict detected on ${conflicts[0].id}!`)
      info(`  Local version: ${conflicts[0].localVersion}`)
      info(`  Remote version: ${conflicts[0].remoteVersion}`)
      info('  Strategy "version": local wins (same version, local takes priority)')
    }
    success('Conflict resolved automatically by strategy')

    await pause()

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Backup & Restore
    // ═══════════════════════════════════════════════════════════════

    step(5, TOTAL_STEPS, 'Backup & Restore from Local File')

    section('Encrypted backup (from file adapter)')
    const encBackup = await company.dump()
    const encParsed = JSON.parse(encBackup)
    success(`Encrypted backup: ${(Buffer.byteLength(encBackup, 'utf-8') / 1024).toFixed(1)} KB`)
    info(`  ${Object.values(encParsed.collections).reduce((n, c) => n + Object.keys(c).length, 0)} records — all ciphertext`)
    info(`  ${Object.keys(encParsed.keyrings).length} keyrings preserved`)
    info('  Safe to email, store on USB, upload — it\'s all encrypted')

    section('Backup/restore round-trip (unencrypted for demo clarity)')
    info('Demonstrating backup/restore using the sync data...')

    section('Dumping office compartment')
    const backup = await officeComp.dump()
    const backupSize = Buffer.byteLength(backup, 'utf-8')
    success(`Backup created: ${(backupSize / 1024).toFixed(1)} KB`)

    const parsed = JSON.parse(backup)
    info(`  Format: _noydb_backup v${parsed._noydb_backup}`)
    info(`  Compartment: ${parsed._compartment}`)
    info(`  Collections: ${Object.keys(parsed.collections).join(', ')}`)
    info(`  Records: ${Object.values(parsed.collections).reduce((n, c) => n + Object.keys(c).length, 0)}`)

    section('Simulating disaster — creating a completely fresh store')
    const freshDb = await createNoydb({
      adapter: memory(),
      user: 'owner',
      encrypt: false,
    })
    const freshComp = await freshDb.openCompartment('C101')

    section('Restoring from backup')
    await freshComp.load(backup)
    success('Backup restored to fresh instance!')

    section('Verifying restored data')
    const restoredInvoices = freshComp.collection('invoices')
    const restoredList = await restoredInvoices.list()
    success(`Restored ${restoredList.length} invoices`)

    for (const inv of restoredList) {
      info(`  ฿${inv.amount.toLocaleString()} — ${inv.status} — from: ${inv.from}`)
    }

    await pause()

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Audit History & Diff
    // ═══════════════════════════════════════════════════════════════

    step(6, TOTAL_STEPS, 'Audit History & Diff')

    info('Every change is tracked automatically. Let\'s see it in action.')

    section('Making a series of changes to an invoice')
    const histComp = await ownerDb.openCompartment('C101')
    const histInvoices = histComp.collection('invoices')

    await histInvoices.put('INV-HIST', { amount: 10000, status: 'draft', client: 'History Demo Co.' })
    success('v1: Created INV-HIST — ฿10,000 (draft)')

    await histInvoices.put('INV-HIST', { amount: 15000, status: 'draft', client: 'History Demo Co.' })
    success('v2: Updated amount — ฿15,000')

    await histInvoices.put('INV-HIST', { amount: 15000, status: 'sent', client: 'History Demo Co.' })
    success('v3: Changed status to sent')

    await histInvoices.put('INV-HIST', { amount: 15000, status: 'paid', client: 'History Demo Co.', paidDate: '2026-04-05' })
    success('v4: Marked as paid, added paidDate')

    section('Viewing full history')
    const history = await histInvoices.history('INV-HIST')
    for (const entry of history) {
      info(`  v${entry.version} [${entry.timestamp.slice(0, 19)}] by ${entry.userId}`)
      info(`    amount: ฿${entry.record.amount.toLocaleString()}, status: ${entry.record.status}`)
    }
    success(`${history.length} history entries (current is v4)`)

    section('Diff between versions')

    const diff_1_2 = await histInvoices.diff('INV-HIST', 1, 2)
    info('v1 → v2:')
    info(`  ${formatDiff(diff_1_2).split('\n').join('\n  ')}`)

    const diff_2_3 = await histInvoices.diff('INV-HIST', 2, 3)
    info('v2 → v3:')
    info(`  ${formatDiff(diff_2_3).split('\n').join('\n  ')}`)

    const diff_3_4 = await histInvoices.diff('INV-HIST', 3, 4)
    info('v3 → v4:')
    info(`  ${formatDiff(diff_3_4).split('\n').join('\n  ')}`)

    const diff_1_current = await histInvoices.diff('INV-HIST', 1)
    info('v1 → current (all changes):')
    info(`  ${formatDiff(diff_1_current).split('\n').join('\n  ')}`)

    section('Time travel — get version 1')
    const v1 = await histInvoices.getVersion('INV-HIST', 1)
    data('INV-HIST at v1', v1)

    section('Revert to version 1')
    await histInvoices.revert('INV-HIST', 1)
    const reverted = await histInvoices.get('INV-HIST')
    success(`Reverted! Current amount: ฿${reverted.amount.toLocaleString()} (was ฿15,000)`)
    info('Revert creates a new version (v5) with v1\'s content — history is preserved')

    const histAfterRevert = await histInvoices.history('INV-HIST')
    success(`History now has ${histAfterRevert.length} entries (v1-v4, current is v5)`)

    section('Pruning — keep only last 2 versions')
    const pruned = await histInvoices.pruneRecordHistory('INV-HIST', { keepVersions: 2 })
    success(`Pruned ${pruned} old history entries`)
    const remaining = await histInvoices.history('INV-HIST')
    success(`${remaining.length} entries remaining (v${remaining.map(e => e.version).join(', v')})`)

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════

    banner('Demo Complete!')
    console.log(`
  You've just seen NOYDB's core features in action:

  \x1b[32m✓\x1b[0m Encrypted CRUD — data is AES-256-GCM encrypted, adapters see only ciphertext
  \x1b[32m✓\x1b[0m File adapter — records stored as JSON files (USB-portable)
  \x1b[32m✓\x1b[0m Multi-user — owner, operator (rw), viewer (ro) with per-collection permissions
  \x1b[32m✓\x1b[0m Access control — viewer blocked from writing (ReadOnlyError)
  \x1b[32m✓\x1b[0m Offline → sync — work offline, push/pull when online
  \x1b[32m✓\x1b[0m Conflict detection — same record edited by two users, resolved by strategy
  \x1b[32m✓\x1b[0m Backup & restore — encrypted JSON dump, portable, restorable
  \x1b[32m✓\x1b[0m Audit history — full version tracking, per-user attribution
  \x1b[32m✓\x1b[0m Diff — field-level change comparison between any versions
  \x1b[32m✓\x1b[0m Time travel — revert to any past version
  \x1b[32m✓\x1b[0m Pruning — clean up old history entries

  \x1b[2mAll data was in: ${tempDir}
  Zero runtime dependencies. Zero knowledge. MIT license.\x1b[0m

  Learn more:
    docs/getting-started.md   — Quick start guide
    docs/adapters.md          — Adapter guide (file, DynamoDB, S3, browser)
    SPEC.md                   — Full specification
    SECURITY.md               — Threat model and crypto details

  GitHub: https://github.com/vLannaAi/noy-db
  `)

    // Close all instances
    ownerDb.close()
    opDb.close()
    viewerDb.close()
    officeDb.close()
    homeDb.close()
    freshDb.close()

  } finally {
    // Cleanup
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    rl.close()
  }
}

main().catch(err => {
  console.error('\n  Demo failed:', err)
  process.exit(1)
})
