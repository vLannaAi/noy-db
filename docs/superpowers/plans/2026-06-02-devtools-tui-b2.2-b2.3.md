# Devtools TUI — B2.2 Records + B2.3 Write Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the terminal inspector — add paged records browsing, a vault-wide live write monitor (events + multi-user overlap + auto-light-up store-latency), and a masked passphrase prompt.

**Architecture:** Two small read-only additions to the `@noy-db/in-devtools` facade (`subscribeConflicts`, `meterSnapshot`), consumed by new ink panes in `@noy-db/in-devtools-tui`. `App` stays the sole state owner; panes are presentational. No hub changes.

**Tech Stack:** TypeScript, ink + React (TUI), vitest + ink-testing-library, `@noy-db/in-devtools` (facade), `@noy-db/to-meter` (optional store metering).

**Spec:** `docs/superpowers/specs/2026-06-02-devtools-tui-b2.2-b2.3-design.md`

---

## File structure

**`packages/in-devtools/` (B1 facade extension)**
- Modify `src/types.ts` — `onWriteConflict` on `InspectorNoydb`; `InspectorWriteConflict`, `InspectorMeter` types; `subscribeConflicts` + `meterSnapshot` on `Inspector`.
- Modify `src/events.ts` — `subscribeConflicts(noydb, handler)`.
- Create `src/meter.ts` — `meterSnapshot(meter)` helper.
- Modify `src/index.ts` — `createInspector(noydb, opts?)`; wire new methods; export new types.
- Modify `package.json` — add `@noy-db/to-meter` as a `devDependency` (type-only import + tests).
- Test: `__tests__/conflicts.test.ts`, `__tests__/meter.test.ts`.

**`packages/in-devtools-tui/` (B2.2 + B2.3 + passphrase tail)**
- Create `src/prompt-passphrase.ts` — masked readline prompt.
- Create `src/panes/RecordsPane.tsx` — paged records table.
- Create `src/panes/WriteMonitor.tsx` — feed + latency header.
- Modify `src/types.ts` — `View`, `DetailTab`, feed-row type.
- Modify `src/App.tsx` — view/tab state + key routing; render Records / Monitor.
- Modify `src/bin.tsx` — masked prompt fallback; optional `--meter` store wrap.
- Modify `package.json` — add `@noy-db/to-meter` as a `dependency`.
- Test: `__tests__/prompt-passphrase.test.ts`, `__tests__/records.test.tsx`, `__tests__/monitor.test.tsx`.

---

## Task 1: B1 facade — `subscribeConflicts`

**Files:**
- Modify: `packages/in-devtools/src/types.ts`
- Modify: `packages/in-devtools/src/events.ts`
- Modify: `packages/in-devtools/src/index.ts`
- Test: `packages/in-devtools/__tests__/conflicts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/in-devtools/__tests__/conflicts.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createInspector } from '../src/index.js'
import type { InspectorNoydb, InspectorWriteConflict } from '../src/types.js'

function fakeNoydb(): InspectorNoydb & { emitConflict: (c: InspectorWriteConflict) => void } {
  const listeners = new Set<(c: InspectorWriteConflict) => void>()
  return {
    // unused-by-this-test members stubbed:
    onAfterWrite: () => () => {},
    writeQueue: { pending: false, depth: 0 },
    listVaults: async () => [],
    onWriteConflict(fn: (c: InspectorWriteConflict) => void) { listeners.add(fn); return () => listeners.delete(fn) },
    emitConflict(c) { for (const l of listeners) l(c) },
  } as unknown as InspectorNoydb & { emitConflict: (c: InspectorWriteConflict) => void }
}

const sampleConflict: InspectorWriteConflict = {
  vault: 'v', collection: 'invoices', docId: 'inv1',
  local: { n: 1 }, remote: { n: 2 }, base: { n: 0 },
  localVersion: 1, remoteVersion: 1, baseVersion: 0,
}

describe('inspector.subscribeConflicts', () => {
  it('fans out conflicts and unsubscribes', () => {
    const db = fakeNoydb()
    const inspector = createInspector(db)
    const seen: InspectorWriteConflict[] = []
    const off = inspector.subscribeConflicts((c) => seen.push(c))
    db.emitConflict(sampleConflict)
    expect(seen).toEqual([sampleConflict])
    off()
    db.emitConflict(sampleConflict)
    expect(seen).toHaveLength(1) // no more after unsubscribe
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test -- conflicts`
Expected: FAIL — `inspector.subscribeConflicts is not a function` (and `InspectorWriteConflict` unresolved).

- [ ] **Step 3: Add types**

In `packages/in-devtools/src/types.ts`, add `WriteConflict` to the hub import and add the new type + interface members:

```ts
// add WriteConflict to the existing `@noy-db/hub` import list
import type {
  Noydb, Vault, WriteEvent, WriteConflict,
  AccessibleVault, CollectionDescriptor, CollectionStats,
} from '@noy-db/hub'

/** Live write-conflict surfaced to subscribers (the hub's public WriteConflict, unchanged). */
export type InspectorWriteConflict = WriteConflict
```

Add `onWriteConflict` to the `InspectorNoydb` interface (find its declaration in this file and add the member):

```ts
  onWriteConflict(handler: (c: InspectorWriteConflict) => void): () => void
```

Add `subscribeConflicts` to the `Inspector` interface (next to `subscribe`):

```ts
  subscribeConflicts(handler: (c: InspectorWriteConflict) => void): () => void
```

- [ ] **Step 4: Implement in events.ts**

In `packages/in-devtools/src/events.ts`, add the import of the new type and the function:

```ts
import type { InspectorWriteEvent, InspectorWriteConflict, PendingWrites, InspectorNoydb } from './types.js'

export function subscribeConflicts(
  noydb: InspectorNoydb,
  handler: (c: InspectorWriteConflict) => void,
): () => void {
  return noydb.onWriteConflict(handler)
}
```

- [ ] **Step 5: Wire into createInspector**

In `packages/in-devtools/src/index.ts`, import and wire it, and export the type:

```ts
import { subscribe, subscribeConflicts, pendingWrites } from './events.js'
// inside the returned object, after `subscribe`:
    subscribeConflicts: (handler) => subscribeConflicts(noydb, handler),
// in the export type { … } block, add:
  InspectorWriteConflict,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools test -- conflicts`
Expected: PASS (1 test).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @noy-db/in-devtools typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/in-devtools/src/types.ts packages/in-devtools/src/events.ts packages/in-devtools/src/index.ts packages/in-devtools/__tests__/conflicts.test.ts
git commit -m "feat(in-devtools): subscribeConflicts — surface write-conflict overlaps (Track B / B2.3)"
```

---

## Task 2: B1 facade — `meterSnapshot` (optional latency)

**Files:**
- Modify: `packages/in-devtools/src/types.ts`
- Create: `packages/in-devtools/src/meter.ts`
- Modify: `packages/in-devtools/src/index.ts`
- Modify: `packages/in-devtools/package.json`
- Test: `packages/in-devtools/__tests__/meter.test.ts`

- [ ] **Step 1: Add to-meter as a devDependency**

In `packages/in-devtools/package.json`, add to `devDependencies`:

```json
    "@noy-db/to-meter": "workspace:*"
```

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 2: Write the failing test**

Create `packages/in-devtools/__tests__/meter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createInspector } from '../src/index.js'
import type { InspectorNoydb, InspectorMeter } from '../src/types.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

const stubNoydb = {
  onAfterWrite: () => () => {}, writeQueue: { pending: false, depth: 0 },
  listVaults: async () => [], onWriteConflict: () => () => {},
} as unknown as InspectorNoydb

const snap = { status: 'ok', totalCalls: 5, byMethod: {}, casConflicts: 0, windowMs: 1000, collectedAt: 'x' } as unknown as MeterSnapshot

describe('inspector.meterSnapshot', () => {
  it('returns null when no meter is supplied', () => {
    expect(createInspector(stubNoydb).meterSnapshot()).toBeNull()
  })
  it('returns the meter snapshot when a handle is supplied', () => {
    const meter: InspectorMeter = { snapshot: () => snap }
    expect(createInspector(stubNoydb, { meter }).meterSnapshot()).toBe(snap)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test -- meter`
Expected: FAIL — `createInspector` takes 1 arg / `meterSnapshot` undefined.

- [ ] **Step 4: Add the meter types**

In `packages/in-devtools/src/types.ts`, add a type-only import and the structural meter type, and the `Inspector` member:

```ts
import type { MeterSnapshot } from '@noy-db/to-meter'

/** Minimal structural view of a to-meter handle the inspector reads (no runtime dep). */
export interface InspectorMeter {
  snapshot(): MeterSnapshot
}
```

Add to the `Inspector` interface (after `subscribeConflicts`):

```ts
  /** Aggregate store-op latency snapshot, or null when the store is not metered. */
  meterSnapshot(): MeterSnapshot | null
```

- [ ] **Step 5: Implement meter.ts**

Create `packages/in-devtools/src/meter.ts`:

```ts
import type { InspectorMeter } from './types.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

export function meterSnapshot(meter: InspectorMeter | undefined): MeterSnapshot | null {
  return meter ? meter.snapshot() : null
}
```

- [ ] **Step 6: Wire into createInspector**

In `packages/in-devtools/src/index.ts`, change the signature and wire it:

```ts
import { meterSnapshot } from './meter.js'
import type { Inspector, InspectorNoydb, InspectorMeter } from './types.js'

export function createInspector(noydb: InspectorNoydb, opts?: { meter?: InspectorMeter }): Inspector {
  return {
    // …existing members…
    meterSnapshot: () => meterSnapshot(opts?.meter),
  }
}
```

Add `InspectorMeter` to the `export type { … }` block.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools test -- meter`
Expected: PASS (2 tests).

- [ ] **Step 8: Full package check + commit**

Run: `pnpm --filter @noy-db/in-devtools test && pnpm --filter @noy-db/in-devtools typecheck && pnpm --filter @noy-db/in-devtools lint`
Expected: all pass (existing 8 + 1 conflict + 2 meter tests).

```bash
git add packages/in-devtools/src/types.ts packages/in-devtools/src/meter.ts packages/in-devtools/src/index.ts packages/in-devtools/package.json packages/in-devtools/__tests__/meter.test.ts pnpm-lock.yaml
git commit -m "feat(in-devtools): optional meterSnapshot — auto-light-up store latency (Track B / B2.3)"
```

---

## Task 3: TUI — masked passphrase prompt (B2.1 tail)

**Files:**
- Create: `packages/in-devtools-tui/src/prompt-passphrase.ts`
- Modify: `packages/in-devtools-tui/src/bin.tsx`
- Test: `packages/in-devtools-tui/__tests__/prompt-passphrase.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/in-devtools-tui/__tests__/prompt-passphrase.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { promptMasked } from '../src/prompt-passphrase.js'

describe('promptMasked', () => {
  it('reads a line, echoes a mask char per keypress, never the plaintext', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let echoed = ''
    output.on('data', (c) => { echoed += c.toString() })
    const p = promptMasked('Passphrase: ', { input, output })
    input.write('s3cr3t')
    input.write('\r')
    const value = await p
    expect(value).toBe('s3cr3t')
    expect(echoed).toContain('Passphrase: ')
    expect(echoed).not.toContain('s3cr3t') // plaintext never echoed
    expect((echoed.match(/•/g) ?? []).length).toBe(6) // one mask per char
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- prompt-passphrase`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the masked prompt**

Create `packages/in-devtools-tui/src/prompt-passphrase.ts`:

```ts
import type { Readable, Writable } from 'node:stream'

export interface PromptStreams {
  input?: Readable & { setRawMode?: (mode: boolean) => void }
  output?: Writable
}

/**
 * Read a line from `input` without echoing the plaintext; emit one `•` per
 * character to `output`. Returns the typed string (Enter terminates).
 * Never logs/persists the value.
 */
export function promptMasked(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = (streams.input ?? process.stdin) as Readable & { setRawMode?: (m: boolean) => void }
  const output = streams.output ?? process.stdout
  return new Promise<string>((resolve) => {
    output.write(question)
    input.setRawMode?.(true)
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      const s = chunk.toString()
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n')
          input.setRawMode?.(false)
          input.removeListener('data', onData)
          resolve(buf)
          return
        }
        if (ch === '' || ch === '') { // backspace / DEL
          if (buf.length > 0) { buf = buf.slice(0, -1); output.write('\b \b') }
          continue
        }
        buf += ch
        output.write('•')
      }
    }
    input.on('data', onData)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- prompt-passphrase`
Expected: PASS (1 test).

- [ ] **Step 5: Wire into the bin**

In `packages/in-devtools-tui/src/bin.tsx`, replace the hard fail when passphrase is missing with the masked prompt. Change:

```ts
  const passphrase = resolvePassphrase(argv, process.env)
  if (passphrase === undefined) fail('no passphrase — pass --passphrase=… or set NOYDB_PASSPHRASE (interactive prompt: B2.1 follow-up)')
```

to:

```ts
  let passphrase = resolvePassphrase(argv, process.env)
  if (passphrase === undefined) {
    if (!process.stdin.isTTY) fail('no passphrase — pass --passphrase=… or set NOYDB_PASSPHRASE')
    passphrase = await promptMasked('Passphrase: ')
  }
```

And add the import near the top:

```ts
import { promptMasked } from './prompt-passphrase.js'
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @noy-db/in-devtools-tui typecheck`
Expected: clean.

```bash
git add packages/in-devtools-tui/src/prompt-passphrase.ts packages/in-devtools-tui/src/bin.tsx packages/in-devtools-tui/__tests__/prompt-passphrase.test.ts
git commit -m "feat(in-devtools-tui): masked interactive passphrase prompt (Track B / B2.1 tail)"
```

---

## Task 4: TUI — Records pane + Tab nav (B2.2)

**Files:**
- Create: `packages/in-devtools-tui/src/panes/RecordsPane.tsx`
- Modify: `packages/in-devtools-tui/src/types.ts`
- Modify: `packages/in-devtools-tui/src/App.tsx`
- Test: `packages/in-devtools-tui/__tests__/records.test.tsx`

- [ ] **Step 1: Add view/tab types**

In `packages/in-devtools-tui/src/types.ts`, replace `export type Focus = 'collections'` with:

```ts
export type View = 'structure' | 'monitor'
export type DetailTab = 'schema' | 'records'
```

- [ ] **Step 2: Write the failing test**

Create `packages/in-devtools-tui/__tests__/records.test.tsx` (reuses the `memoryStore`/`setup` harness from `app.test.tsx` — copy those helpers in, or import if exported):

```tsx
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { createNoydb, ConflictError } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createInspector } from '@noy-db/in-devtools'
import { App } from '../src/App.js'

// (paste the memoryStore() helper from app.test.tsx here)

async function setupRecords() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('books')
  const notes = vault.collection<{ id: string; n: number }>('notes')
  for (let i = 0; i < 3; i++) await notes.put('n' + i, { id: 'n' + i, n: i })
  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  return { inspector, vault, initial }
}

describe('records pane (B2.2)', () => {
  it('Tab switches the detail to Records and shows a paged window', async () => {
    const { inspector, vault, initial } = await setupRecords()
    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('\r')      // drill into first collection (notes)
    stdin.write('\t')      // Tab → Records
    await new Promise((r) => setTimeout(r, 80))
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/rows 1.\d+ of 3/)  // header shows the window of total
    expect(frame).toContain('n0')             // a record id rendered
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- records`
Expected: FAIL — no Records rendering (`rows … of 3` absent).

- [ ] **Step 4: Implement RecordsPane**

Create `packages/in-devtools-tui/src/panes/RecordsPane.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { RecordPage, InspectorCollection } from '@noy-db/in-devtools'

function cell(value: unknown): string {
  if (value === null || value === undefined) return '·'
  if (typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}'
  return String(value)
}

export function RecordsPane({ collection, page, error }: {
  collection: InspectorCollection
  page: RecordPage | null
  error?: string
}) {
  const fields = Object.keys(collection.fields)
  if (error) return <Box flexDirection="column"><Text color="red">records error: {error}</Text><Text dimColor>n/p retry · ⇥ back</Text></Box>
  if (!page) return <Box flexDirection="column"><Text dimColor>loading records…</Text></Box>
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = Math.min(page.offset + page.limit, page.total)
  return (
    <Box flexDirection="column">
      <Text bold>rows {from}–{to} of {page.total} <Text dimColor>(n/p page · ⇥ back)</Text></Text>
      <Text dimColor>{fields.join('  ')}</Text>
      {page.rows.map((row, i) => (
        <Text key={i}>{fields.map((f) => cell((row as Record<string, unknown>)?.[f])).join('  ')}</Text>
      ))}
    </Box>
  )
}
```

- [ ] **Step 5: Wire Records into App**

In `packages/in-devtools-tui/src/App.tsx`, add records state + Tab/paging routing and render. Replace the component body with (keeping VaultList/CollectionList/DetailPane imports, adding RecordsPane):

```tsx
import React, { useState, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { AppProps, DetailTab } from './types.js'
import type { RecordPage } from '@noy-db/in-devtools'
import { VaultList } from './panes/VaultList.js'
import { CollectionList } from './panes/CollectionList.js'
import { DetailPane } from './panes/DetailPane.js'
import { RecordsPane } from './panes/RecordsPane.js'

const PAGE = 20

export function App({ inspector, vault, vaultName, initial }: AppProps) {
  const { exit } = useApp()
  const vaults = initial?.vaults ?? []
  const snapshot = initial?.snapshot
  const collections = snapshot?.collections ?? []
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [drilled, setDrilled] = useState(false)
  const [tab, setTab] = useState<DetailTab>('schema')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<RecordPage | null>(null)
  const [recErr, setRecErr] = useState<string | undefined>(undefined)
  const current = collections[selectedIdx]

  useEffect(() => {
    if (!drilled || tab !== 'records' || !current) return
    let live = true
    setPage(null); setRecErr(undefined)
    inspector.records(vault, current.name, { limit: PAGE, offset })
      .then((p) => { if (live) setPage(p) })
      .catch((e) => { if (live) setRecErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [drilled, tab, current, offset, inspector, vault])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (!drilled) {
      if (key.downArrow) setSelectedIdx((i) => Math.min(collections.length - 1, i + 1))
      if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1))
      if (key.return) { setDrilled(true); setTab('schema') }
      return
    }
    // drilled:
    if (key.escape) { setDrilled(false); setTab('schema'); setOffset(0) }
    if (key.tab) { setTab((t) => (t === 'schema' ? 'records' : 'schema')); setOffset(0) }
    if (tab === 'records' && page) {
      if (input === 'n' && offset + PAGE < page.total) setOffset((o) => o + PAGE)
      if (input === 'p' && offset - PAGE >= 0) setOffset((o) => o - PAGE)
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>noy-db inspector — {vaultName} <Text dimColor>(↑/↓ · ↵ drill · ⇥ tab · q quit)</Text></Text>
      <Box marginTop={1}>
        <VaultList vaults={vaults} activeName={vaultName} />
        <CollectionList snapshot={snapshot ?? { vault: vaultName, collections: [] }} selectedIdx={selectedIdx} />
        {drilled && tab === 'records' && current
          ? <RecordsPane collection={current} page={page} error={recErr} />
          : <DetailPane collection={drilled ? current : undefined} />}
      </Box>
    </Box>
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- records`
Expected: PASS.

- [ ] **Step 7: Run the full package test (no regression on app.test.tsx)**

Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: all pass (existing app + records + prompt).

- [ ] **Step 8: Commit**

```bash
git add packages/in-devtools-tui/src/panes/RecordsPane.tsx packages/in-devtools-tui/src/types.ts packages/in-devtools-tui/src/App.tsx packages/in-devtools-tui/__tests__/records.test.tsx
git commit -m "feat(in-devtools-tui): paged records pane + Tab nav (Track B / B2.2)"
```

---

## Task 5: TUI — Write Monitor view + feed (B2.3 core)

**Files:**
- Create: `packages/in-devtools-tui/src/panes/WriteMonitor.tsx`
- Modify: `packages/in-devtools-tui/src/types.ts`
- Modify: `packages/in-devtools-tui/src/App.tsx`
- Test: `packages/in-devtools-tui/__tests__/monitor.test.tsx`

- [ ] **Step 1: Add feed-row + view state types**

In `packages/in-devtools-tui/src/types.ts`, add:

```ts
import type { InspectorWriteEvent, InspectorWriteConflict } from '@noy-db/in-devtools'

export interface FeedRow {
  readonly time: string        // HH:MM:SS
  readonly user: string
  readonly op: 'put' | 'del'
  readonly target: string      // collection/docId
  readonly versions: string    // "2→3" or "4→·"
  readonly baseKey: string     // collection/docId@baseVersion (overlap detection)
  conflict: boolean
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/in-devtools-tui/__tests__/monitor.test.tsx` with a scriptable fake inspector:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App } from '../src/App.js'
import type { Inspector, InspectorWriteEvent, InspectorWriteConflict } from '@noy-db/in-devtools'
import type { Vault } from '@noy-db/hub'

function fakeInspector() {
  let onWrite: ((e: InspectorWriteEvent) => void) | null = null
  let onConflict: ((c: InspectorWriteConflict) => void) | null = null
  const inspector: Inspector = {
    listVaults: async () => [{ id: 'books', role: 'owner' } as never],
    snapshot: async () => ({ vault: 'books', collections: [{ name: 'invoices', fields: { id: {}, amount: {} } as never, indexes: [] as never, refs: [] as never }] }),
    records: async () => ({ rows: [], total: 0, limit: 20, offset: 0 }),
    subscribe: (h) => { onWrite = h; return () => { onWrite = null } },
    subscribeConflicts: (h) => { onConflict = h; return () => { onConflict = null } },
    pendingWrites: () => ({ pending: false, depth: 0 }),
    meterSnapshot: () => null,
  }
  return {
    inspector,
    emitWrite: (e: InspectorWriteEvent) => onWrite?.(e),
    emitConflict: (c: InspectorWriteConflict) => onConflict?.(c),
  }
}

const W = (over: Partial<InspectorWriteEvent>): InspectorWriteEvent => ({
  op: 'update', vault: 'books', collection: 'invoices', docId: 'inv1',
  before: {}, after: {}, baseVersion: 2, version: 3, userId: 'alice', timestamp: 1_000_000, txId: 't', ...over,
})

describe('write monitor (B2.3)', () => {
  it("'w' opens the monitor and streams writes newest-first; conflicts highlight", async () => {
    const f = fakeInspector()
    const initial = { vaults: await f.inspector.listVaults(), snapshot: await f.inspector.snapshot({} as Vault) }
    const { lastFrame, stdin } = render(<App inspector={f.inspector} vault={{} as Vault} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('w')  // open monitor
    await new Promise((r) => setTimeout(r, 30))
    f.emitWrite(W({ userId: 'alice', docId: 'inv1', baseVersion: 2, version: 3 }))
    f.emitWrite(W({ userId: 'bob', docId: 'inv1', baseVersion: 2, version: 3 }))
    f.emitConflict({ vault: 'books', collection: 'invoices', docId: 'inv1', local: {}, remote: {}, base: {}, localVersion: 3, remoteVersion: 3, baseVersion: 2 })
    await new Promise((r) => setTimeout(r, 50))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Write Monitor')
    expect(frame).toContain('alice')
    expect(frame).toContain('bob')
    expect(frame).toContain('CONFLICT')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- monitor`
Expected: FAIL — no `Write Monitor` rendering.

- [ ] **Step 4: Implement WriteMonitor**

Create `packages/in-devtools-tui/src/panes/WriteMonitor.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { FeedRow } from '../types.js'

export function WriteMonitor({ vaultName, rows }: { vaultName: string; rows: ReadonlyArray<FeedRow> }) {
  return (
    <Box flexDirection="column">
      <Text bold>Write Monitor — {vaultName} <Text dimColor>(w/esc · c clear · q quit)</Text></Text>
      <Text dimColor>time      user    op   collection/docId    v</Text>
      {rows.length === 0 && <Text dimColor>(waiting for writes…)</Text>}
      {rows.map((r, i) => (
        <Text key={i} color={r.conflict ? 'yellow' : undefined}>
          {r.time}  {r.user.padEnd(6)}  {r.op}  {r.target.padEnd(18)} {r.versions}{r.conflict ? '  ⚠ CONFLICT' : ''}
        </Text>
      ))}
    </Box>
  )
}
```

- [ ] **Step 5: Wire the monitor into App**

In `packages/in-devtools-tui/src/App.tsx`, add monitor state, subscriptions, and the `w`/Esc/`c` routing. Add imports:

```tsx
import type { AppProps, DetailTab, View, FeedRow } from './types.js'
import { WriteMonitor } from './panes/WriteMonitor.js'
```

Add a helper above the component:

```tsx
const BUFFER = 200
function fmtTime(ts: number): string { const d = new Date(ts); return d.toTimeString().slice(0, 8) }
function rowOf(e: import('@noy-db/in-devtools').InspectorWriteEvent): FeedRow {
  const op = e.op === 'delete' ? 'del' : 'put'
  const versions = e.op === 'delete' ? `${e.baseVersion}→·` : `${e.baseVersion}→${e.version}`
  return { time: fmtTime(e.timestamp), user: e.userId, op, target: `${e.collection}/${e.docId}`, versions, baseKey: `${e.collection}/${e.docId}@${e.baseVersion}`, conflict: false }
}
```

Add state + effect inside the component (after the records state):

```tsx
  const [view, setView] = useState<View>('structure')
  const [feed, setFeed] = useState<ReadonlyArray<FeedRow>>([])
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (!started) return
    const offW = inspector.subscribe((e) => {
      setFeed((prev) => {
        const row = rowOf(e)
        // overlap: same baseKey already present from a different user → flag both
        const overlap = prev.some((r) => r.baseKey === row.baseKey && r.user !== row.user)
        if (overlap) row.conflict = true
        const next = [overlap ? { ...row } : row, ...prev.map((r) => (r.baseKey === row.baseKey && r.user !== row.user ? { ...r, conflict: true } : r))]
        return next.slice(0, BUFFER)
      })
    })
    const offC = inspector.subscribeConflicts((c) => {
      const key = `${c.collection}/${c.docId}@${c.baseVersion}`
      setFeed((prev) => prev.map((r) => (r.baseKey === key ? { ...r, conflict: true } : r)))
    })
    return () => { offW(); offC() }
  }, [started, inspector])
```

Extend the key handler: at the top of `useInput`, before the `!drilled` block, add the global view toggle:

```tsx
    if (view === 'monitor') {
      if (key.escape) setView('structure')
      if (input === 'c') setFeed([])
      return
    }
    if (input === 'w') { setView('monitor'); setStarted(true); return }
```

And switch the render root on `view`:

```tsx
  if (view === 'monitor') return <WriteMonitor vaultName={vaultName} rows={feed} />
  return ( /* the existing structure Box */ )
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- monitor`
Expected: PASS.

- [ ] **Step 7: Full package test + typecheck**

Run: `pnpm --filter @noy-db/in-devtools-tui test && pnpm --filter @noy-db/in-devtools-tui typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/in-devtools-tui/src/panes/WriteMonitor.tsx packages/in-devtools-tui/src/types.ts packages/in-devtools-tui/src/App.tsx packages/in-devtools-tui/__tests__/monitor.test.tsx
git commit -m "feat(in-devtools-tui): write monitor — live feed + multi-user overlap/conflict (Track B / B2.3)"
```

---

## Task 6: TUI — Monitor latency readout + `--meter` (B2.3 latency)

**Files:**
- Modify: `packages/in-devtools-tui/src/panes/WriteMonitor.tsx`
- Modify: `packages/in-devtools-tui/src/App.tsx`
- Modify: `packages/in-devtools-tui/src/bin.tsx`
- Modify: `packages/in-devtools-tui/package.json`
- Test: `packages/in-devtools-tui/__tests__/monitor.test.tsx`

- [ ] **Step 1: Add the latency test (extend monitor.test.tsx)**

Append to `monitor.test.tsx` a case with a metered fake. Add to the `fakeInspector` factory an optional snapshot, or write a second factory:

```tsx
import type { MeterSnapshot } from '@noy-db/to-meter'

const meterSnap = {
  status: 'degraded', totalCalls: 50, casConflicts: 0, windowMs: 1000, collectedAt: 'x',
  byMethod: { put: { count: 43, errors: 0, p50: 11, p90: 60, p99: 92, max: 120, avg: 20 }, delete: { count: 5, errors: 0, p50: 4, p90: 7, p99: 9, max: 12, avg: 5 } },
} as unknown as MeterSnapshot

it('shows the latency readout when the store is metered, hidden when not', async () => {
  const f = fakeInspector()
  ;(f.inspector as { meterSnapshot: () => MeterSnapshot | null }).meterSnapshot = () => meterSnap
  const initial = { vaults: await f.inspector.listVaults(), snapshot: await f.inspector.snapshot({} as never) }
  const { lastFrame, stdin } = render(<App inspector={f.inspector} vault={{} as never} vaultName="books" initial={initial} />)
  await new Promise((r) => setTimeout(r, 100))
  stdin.write('w')
  await new Promise((r) => setTimeout(r, 60))
  const frame = lastFrame() ?? ''
  expect(frame).toContain('put p50 11ms p99 92ms')
  expect(frame).toContain('degraded')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- monitor`
Expected: FAIL — no latency line yet.

- [ ] **Step 3: Render the latency header**

In `WriteMonitor.tsx`, accept and render a `meter` prop. Add to the props and just under the title:

```tsx
import type { MeterSnapshot } from '@noy-db/to-meter'

export function WriteMonitor({ vaultName, rows, meter }: { vaultName: string; rows: ReadonlyArray<FeedRow>; meter: MeterSnapshot | null }) {
  const m = meter?.byMethod
  return (
    <Box flexDirection="column">
      <Text bold>Write Monitor — {vaultName} <Text dimColor>(w/esc · c clear · q quit)</Text></Text>
      {meter && m && (
        <Text>
          store  put p50 {m.put?.p50 ?? '—'}ms p99 {m.put?.p99 ?? '—'}ms{meter.status === 'degraded' ? ' ⚠degraded' : ''} · del p50 {m.delete?.p50 ?? '—'} p99 {m.delete?.p99 ?? '—'} · get p50 {m.get?.p50 ?? '—'} p99 {m.get?.p99 ?? '—'}
        </Text>
      )}
      <Text dimColor>time      user    op   collection/docId    v</Text>
      {/* …rows as before… */}
    </Box>
  )
}
```

- [ ] **Step 4: Poll the snapshot in App while the monitor is mounted**

In `App.tsx`, add meter state + a 1s poll gated on `view === 'monitor'`:

```tsx
  const [meter, setMeter] = useState<import('@noy-db/to-meter').MeterSnapshot | null>(null)
  useEffect(() => {
    if (view !== 'monitor') return
    const tick = () => setMeter(inspector.meterSnapshot())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [view, inspector])
```

Pass it to the monitor: `return <WriteMonitor vaultName={vaultName} rows={feed} meter={meter} />`

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test -- monitor`
Expected: PASS (both monitor cases).

- [ ] **Step 6: Add `--meter` to the bin**

In `packages/in-devtools-tui/package.json`, add to `dependencies`:

```json
    "@noy-db/to-meter": "workspace:*"
```

Run `pnpm install`. Then in `bin.tsx`, optionally wrap the store and pass the handle:

```tsx
import { toMeter } from '@noy-db/to-meter'
// after baseOptions is loaded, before createNoydb:
  let meter
  if (argv.includes('--meter') && baseOptions.store) {
    const metered = toMeter(baseOptions.store)
    baseOptions = { ...baseOptions, store: metered.store }
    meter = metered.meter
  }
  const options: NoydbOptions = { ...baseOptions, secret: passphrase }
  const db = await createNoydb(options)
  // …openVault…
  const inspector = createInspector(db, meter ? { meter } : undefined)
```

- [ ] **Step 7: Full package check + commit**

Run: `pnpm --filter @noy-db/in-devtools-tui test && pnpm --filter @noy-db/in-devtools-tui typecheck && pnpm --filter @noy-db/in-devtools-tui lint`
Expected: all pass.

```bash
git add packages/in-devtools-tui/src/panes/WriteMonitor.tsx packages/in-devtools-tui/src/App.tsx packages/in-devtools-tui/src/bin.tsx packages/in-devtools-tui/package.json packages/in-devtools-tui/__tests__/monitor.test.tsx pnpm-lock.yaml
git commit -m "feat(in-devtools-tui): auto-light-up store-latency readout + --meter (Track B / B2.3)"
```

---

## Task 7: Showcase + registry + final gate

**Files:**
- Create: `showcases/src/91-in-devtools-records-monitor.showcase.test.ts`
- Modify: `features.yaml` (in-devtools description)
- Modify: `packages/in-devtools/CHANGELOG.md`, `packages/in-devtools-tui/CHANGELOG.md`

- [ ] **Step 1: Write a headless showcase exercising the new facade**

Create `showcases/src/91-in-devtools-records-monitor.showcase.test.ts` (follow showcase 90's structure; verify `records` paging + a `subscribe`/`subscribeConflicts` round-trip against an in-memory vault):

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { createInspector } from '@noy-db/in-devtools'
// (reuse the showcase memory-store helper used by showcase 90)

describe('showcase 91 — in-devtools records + monitor', () => {
  it('pages records and streams write events', async () => {
    const db = await createNoydb({ store: /* memory */ undefined as never, user: 'owner', secret: 'pw' })
    const vault = await db.openVault('v')
    const c = vault.collection<{ id: string; n: number }>('items')
    for (let i = 0; i < 5; i++) await c.put('i' + i, { id: 'i' + i, n: i })
    const inspector = createInspector(db)
    const seen: string[] = []
    const off = inspector.subscribe((e) => seen.push(e.docId))
    const page = await inspector.records(vault, 'items', { limit: 2, offset: 0 })
    expect(page.total).toBe(5)
    expect(page.rows).toHaveLength(2)
    await c.put('i5', { id: 'i5', n: 5 })
    expect(seen).toContain('i5')
    off()
  })
})
```

> Note: copy showcase 90's exact memory-store/bootstrap helper rather than the placeholder above — match its imports and store construction.

- [ ] **Step 2: Run the showcase**

Run: `pnpm --filter @noy-db/showcases test -- 91-in-devtools`
Expected: PASS.

- [ ] **Step 3: Update CHANGELOGs**

Prepend to `packages/in-devtools/CHANGELOG.md` under a new `## 0.2.0-pre.5` … (the release bump will reconcile the version label) — actually add the entry beneath the existing `## 0.2.0-pre.5` debut block as bullet items:

```md
- `subscribeConflicts(handler)` — surface multi-user/multi-tab write-conflict overlaps.
- `createInspector(db, { meter })` + `meterSnapshot()` — optional aggregate store-op latency (null when unmetered).
```

Prepend to `packages/in-devtools-tui/CHANGELOG.md` similarly:

```md
- Records pane (paged `inspector.records`, Tab to switch, n/p to page).
- Write Monitor (`w`): live write feed with multi-user overlap/conflict highlighting + auto-light-up store-latency (`--meter`).
- Masked interactive passphrase prompt.
```

- [ ] **Step 4: Note new capabilities in features.yaml**

In `features.yaml`, find the `in-devtools` entry and extend its `description` to mention records browsing + the write monitor. Keep the entry's `spec`/`framework` keys unchanged.

- [ ] **Step 5: Run the full required-gate suite locally**

Run:
```bash
pnpm validate:features && pnpm check:architecture && pnpm build && pnpm lint && pnpm typecheck
pnpm turbo test --concurrency=1 --filter @noy-db/in-devtools --filter @noy-db/in-devtools-tui --filter @noy-db/showcases
```
Expected: all green. (Serial test run mirrors CI and avoids the known load-flake.)

- [ ] **Step 6: Commit**

```bash
git add showcases/src/91-in-devtools-records-monitor.showcase.test.ts features.yaml packages/in-devtools/CHANGELOG.md packages/in-devtools-tui/CHANGELOG.md
git commit -m "test(devtools): showcase 91 + registry/changelog for records + write monitor (Track B)"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feat/track-b-devtools-b2.2-b2.3
gh pr create --base main --title "feat(devtools): Track B B2.2 records + B2.3 write monitor" --body "Finishes the TUI per docs/superpowers/specs/2026-06-02-devtools-tui-b2.2-b2.3-design.md (#265). Adds inspector.subscribeConflicts + optional meterSnapshot; records pane; write monitor with multi-user overlap + auto-light-up latency; masked passphrase prompt."
```

Then wait for the 4 required checks; let CI Test settle (rerun if the known `tab-write-propagation` flake appears); squash-merge.

---

## Self-review

**Spec coverage:**
- ① B1 `subscribeConflicts` → Task 1. ① `meterSnapshot`/`createInspector(db,{meter})` → Task 2. ✓
- ② Records pane (Tab, paging, generic render) → Task 4. ✓
- ③ Write Monitor (global `w`, feed, overlap, conflict, latency light-up, lifecycle) → Tasks 5–6. ✓
- ④ Masked passphrase → Task 3. ✓
- ⑤ Testing → tests in every task. ⑥ Showcase/registry → Task 7. ✓

**Type consistency:** `InspectorWriteConflict` (Task 1) matches the hub `WriteConflict` fields used in the Task 5 conflict emit. `MeterSnapshot.byMethod[method].{p50,p99}` (Task 2/6) matches `to-meter`'s `MethodStats`. `FeedRow` defined once (Task 5), consumed by `WriteMonitor` + App. `DetailTab`/`View` defined in Task 4/5 types, used in App.

**Known risk:** the `tab-write-propagation` hub flake (memory-pinned) can red CI Test on node 20 — rerun clears it; not caused by this work.

**Notes for the implementer:**
- The `memoryStore()` helper is duplicated across TUI tests — acceptable (test isolation); if it grows, extract to `__tests__/helpers.ts`.
- `InspectorNoydb` already narrows the hub `Noydb`; only `onWriteConflict` is added — confirm the real `Noydb.onWriteConflict` signature returns an unsubscribe (it does: `noydb.ts:1290`).
