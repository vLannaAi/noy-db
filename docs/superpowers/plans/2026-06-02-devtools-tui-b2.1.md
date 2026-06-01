# Devtools TUI — B2.1 (Shell + Structure Navigation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@noy-db/in-devtools-tui` slice B2.1 — an ink/React terminal app (`noydb-inspect` bin) that opens a vault (config + passphrase) and renders a keyboard-navigable **vaults → collections → schema/stats** tree via the B1 `createInspector`.

**Architecture:** Standalone package, ink (+React) UI, consumes `@noy-db/in-devtools` only. The `App` component owns selection state + key routing; panes are presentational. The bin loads a `.js/.mjs` config, resolves a passphrase (flag/env/masked prompt), opens the vault, builds the inspector, and renders. Read-only; passphrase used only for `openVault`.

**Tech Stack:** TypeScript + TSX (`jsx: react-jsx`), ink ^5, react ^18, ink-testing-library ^4, tsup, vitest (node env). Spec: `docs/superpowers/specs/2026-06-02-devtools-inspector-b2-tui-design.md`.

**Scope:** B2.1 only — structure nav. Records (B2.2) and live feed (B2.3) are later slices. The masked interactive prompt is a thin fallback; the tested surface is the `App` + config loader + passphrase resolution.

---

## File Structure

```
packages/in-devtools-tui/
  package.json        # ink/react deps; hub + in-devtools peers; bin: noydb-inspect
  tsconfig.json       # extends base; jsx: react-jsx
  tsup.config.ts      # entry src/bin.tsx, format esm, banner #!/usr/bin/env node
  vitest.config.ts    # node env
  src/
    types.ts          # AppProps, Focus
    load-options.ts   # config loader (.js/.mjs dynamic import) + passphrase resolution
    panes/
      VaultList.tsx    # presentational
      CollectionList.tsx
      DetailPane.tsx
    App.tsx           # root: state + useInput + renders panes
    bin.tsx           # argv → load → open → createInspector → render
  __tests__/
    load-options.test.ts
    app.test.tsx      # ink-testing-library
```

---

### Task 1: Scaffold the package

**Files:** Create `packages/in-devtools-tui/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/bin.tsx}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@noy-db/in-devtools-tui",
  "version": "0.2.0-pre.3",
  "description": "Interactive terminal inspector for a live noy-db (ink TUI over @noy-db/in-devtools).",
  "license": "MIT",
  "type": "module",
  "bin": { "noydb-inspect": "./dist/bin.js" },
  "main": "./dist/bin.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "ink": "^5.0.1", "react": "^18.3.1" },
  "peerDependencies": { "@noy-db/hub": "workspace:*", "@noy-db/in-devtools": "workspace:*" },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "@noy-db/in-devtools": "workspace:*",
    "@noy-db/to-memory": "workspace:*",
    "ink-testing-library": "^4.0.0",
    "@types/react": "^18.3.12",
    "react": "^18.3.1"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (jsx enabled)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `tsup.config.ts`** (executable bin)

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/bin.tsx'],
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  banner: { js: '#!/usr/bin/env node' },
})
```

- [ ] **Step 4: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'in-devtools-tui', environment: 'node', include: ['__tests__/**/*.test.{ts,tsx}'] },
})
```

- [ ] **Step 5: stub `src/bin.tsx`**

```tsx
export {}
```

- [ ] **Step 6: install + typecheck**

Run: `pnpm install` then `pnpm --filter @noy-db/in-devtools-tui typecheck`
Expected: install resolves ink/react; typecheck passes (empty module). If `@types/react` version is unavailable, use the latest `^18` that resolves.

- [ ] **Step 7: Commit**

```bash
git add packages/in-devtools-tui/package.json packages/in-devtools-tui/tsconfig.json packages/in-devtools-tui/tsup.config.ts packages/in-devtools-tui/vitest.config.ts packages/in-devtools-tui/src/bin.tsx pnpm-lock.yaml
git commit -m "feat(in-devtools-tui): scaffold the ink TUI package (Track B / B2.1)"
```

---

### Task 2: Config loader + passphrase resolution

**Files:** Create `src/load-options.ts`, `src/types.ts`; Test: `__tests__/load-options.test.ts`

- [ ] **Step 1: Write the failing test** — `__tests__/load-options.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolvePassphrase } from '../src/load-options.js'

describe('resolvePassphrase', () => {
  it('prefers --passphrase=… from argv', () => {
    expect(resolvePassphrase(['--passphrase=hunter2'], {})).toBe('hunter2')
  })
  it('falls back to NOYDB_PASSPHRASE env', () => {
    expect(resolvePassphrase([], { NOYDB_PASSPHRASE: 'fromenv' })).toBe('fromenv')
  })
  it('returns undefined when neither is given (caller must prompt)', () => {
    expect(resolvePassphrase([], {})).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: FAIL — `resolvePassphrase` not found.

- [ ] **Step 3: Implement `src/types.ts`**

```tsx
import type { Vault } from '@noy-db/hub'
import type { Inspector, VaultInfo, InspectorSnapshot } from '@noy-db/in-devtools'

export type Focus = 'collections'

export interface AppProps {
  readonly inspector: Inspector
  readonly vault: Vault
  readonly vaultName: string
  /** Injected in tests so the app renders synchronously without async load races. */
  readonly initial?: { vaults: ReadonlyArray<VaultInfo>; snapshot: InspectorSnapshot }
}
```

- [ ] **Step 4: Implement `src/load-options.ts`**

```ts
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Load a NoydbOptions object from a `.js`/`.mjs` config (default export, or a
 * factory function). Mirrors @noy-db/cli's loader; reimplemented here to avoid
 * coupling the TUI bin to the whole cli package. `.ts` is unsupported (Node has
 * no native loader) — compile first or use a `.mjs` config.
 */
export async function loadOptionsFromFile(filePath: string): Promise<unknown> {
  const abs = resolvePath(filePath)
  if (/\.[mc]?ts$/.test(abs)) {
    throw new Error(
      `TypeScript config files are not directly loadable. Compile it first, or use a .mjs/.js config.`,
    )
  }
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown }
  const value = mod.default ?? mod
  return typeof value === 'function' ? await (value as () => Promise<unknown>)() : value
}

/** Resolve the passphrase from `--passphrase=…` or `NOYDB_PASSPHRASE`; undefined → caller prompts. */
export function resolvePassphrase(argv: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const flag = argv.find((a) => a.startsWith('--passphrase='))
  if (flag) return flag.slice('--passphrase='.length)
  if (env.NOYDB_PASSPHRASE) return env.NOYDB_PASSPHRASE
  return undefined
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/in-devtools-tui/src/load-options.ts packages/in-devtools-tui/src/types.ts packages/in-devtools-tui/__tests__/load-options.test.ts
git commit -m "feat(in-devtools-tui): config loader + passphrase resolution (Track B / B2.1)"
```

---

### Task 3: The ink App + panes (structure nav)

**Files:** Create `src/panes/{VaultList,CollectionList,DetailPane}.tsx`, `src/App.tsx`; Test: `__tests__/app.test.tsx`

- [ ] **Step 1: Write the failing test** — `__tests__/app.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { createNoydb, ConflictError } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createInspector } from '@noy-db/in-devtools'
import { App } from '../src/App.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const m = coll(v, c); const ex = m.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); m.set(id, env) },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async listVaults() { return [...data.keys()] },
    async loadAll(v) { const vm = data.get(v); const s: VaultSnapshot = {}; if (vm) for (const [cn, cm] of vm) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of cm) r[id] = e; s[cn] = r } return s },
    async saveAll() {},
  }
}

async function setup() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('books')
  await vault.collection<{ id: string; n: number }>('notes').put('a', { id: 'a', n: 1 })
  await vault.collection<{ id: string; n: number }>('tags').put('t', { id: 't', n: 9 })
  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  return { inspector, vault, initial }
}

describe('TUI App', () => {
  it('renders the vault and its collections', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('books')
    expect(frame).toContain('notes')
    expect(frame).toContain('tags')
  })

  it('down-arrow moves the collection selection; Enter shows its detail', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    stdin.write('[B') // down arrow → select second collection
    stdin.write('\r')       // enter → drill into detail
    const frame = lastFrame() ?? ''
    // Detail pane shows the selected collection's stats (record count).
    expect(frame).toMatch(/records?/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: FAIL — `../src/App.js` not found.

- [ ] **Step 3: Implement the panes**

`src/panes/VaultList.tsx`:
```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { VaultInfo } from '@noy-db/in-devtools'

export function VaultList({ vaults, activeName }: { vaults: ReadonlyArray<VaultInfo>; activeName: string }) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Vaults</Text>
      {vaults.map((v) => (
        <Text key={v.id} color={v.id === activeName ? 'green' : undefined}>
          {v.id === activeName ? '› ' : '  '}{v.id}
        </Text>
      ))}
    </Box>
  )
}
```

`src/panes/CollectionList.tsx`:
```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorSnapshot } from '@noy-db/in-devtools'

export function CollectionList({ snapshot, selectedIdx }: { snapshot: InspectorSnapshot; selectedIdx: number }) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Collections</Text>
      {snapshot.collections.map((c, i) => (
        <Text key={c.name} color={i === selectedIdx ? 'cyan' : undefined} inverse={i === selectedIdx}>
          {c.name}
        </Text>
      ))}
    </Box>
  )
}
```

`src/panes/DetailPane.tsx`:
```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorCollection } from '@noy-db/in-devtools'

export function DetailPane({ collection }: { collection: InspectorCollection | undefined }) {
  if (!collection) return (
    <Box flexDirection="column"><Text dimColor>Select a collection (↵)</Text></Box>
  )
  const fieldNames = Object.keys(collection.fields)
  return (
    <Box flexDirection="column">
      <Text bold underline>{collection.name}</Text>
      <Text>records: {collection.stats?.records ?? '—'}  bytes: {collection.stats?.bytes ?? '—'}</Text>
      <Text>fields: {fieldNames.length ? fieldNames.join(', ') : '(none)'}</Text>
    </Box>
  )
}
```

- [ ] **Step 4: Implement `src/App.tsx`**

```tsx
import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { AppProps } from './types.js'
import { VaultList } from './panes/VaultList.js'
import { CollectionList } from './panes/CollectionList.js'
import { DetailPane } from './panes/DetailPane.js'

export function App({ vaultName, vaultName: _vn, initial, ...rest }: AppProps) {
  const { exit } = useApp()
  const vaults = initial?.vaults ?? []
  const snapshot = initial?.snapshot
  const collections = snapshot?.collections ?? []
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [drilled, setDrilled] = useState(false)
  void rest

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (key.downArrow) setSelectedIdx((i) => Math.min(collections.length - 1, i + 1))
    if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1))
    if (key.return) setDrilled(true)
    if (key.escape) setDrilled(false)
  })

  return (
    <Box flexDirection="column">
      <Text bold>noy-db inspector — {vaultName} <Text dimColor>(↑/↓ select · ↵ detail · q quit)</Text></Text>
      <Box marginTop={1}>
        <VaultList vaults={vaults} activeName={vaultName} />
        <CollectionList snapshot={snapshot ?? { vault: vaultName, collections: [] }} selectedIdx={selectedIdx} />
        <DetailPane collection={drilled ? collections[selectedIdx] : undefined} />
      </Box>
    </Box>
  )
}
```

> Note: B2.1 renders from the injected `initial` data (loaded once by the bin before mount). This keeps the `App` pure and synchronously testable. Async in-app loading (re-`snapshot()` on demand) is deferred — the bin loads the snapshot at boot.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: PASS (both app tests + the 3 loader tests).

- [ ] **Step 6: Commit**

```bash
git add packages/in-devtools-tui/src/App.tsx packages/in-devtools-tui/src/panes packages/in-devtools-tui/__tests__/app.test.tsx
git commit -m "feat(in-devtools-tui): ink App + panes with structure nav (Track B / B2.1)"
```

---

### Task 4: The bin (boot flow)

**Files:** Modify `src/bin.tsx`

- [ ] **Step 1: Implement `src/bin.tsx`** (no unit test — it's the wiring shell; its parts are tested in Tasks 2–3)

```tsx
import React from 'react'
import { render } from 'ink'
import { createInspector } from '@noy-db/in-devtools'
import { createNoydb } from '@noy-db/hub'
import type { NoydbOptions } from '@noy-db/hub'
import { App } from './App.js'
import { loadOptionsFromFile, resolvePassphrase } from './load-options.js'

function fail(msg: string): never {
  process.stderr.write(`noydb-inspect: ${msg}\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const configPath = argv.find((a) => !a.startsWith('--'))
  if (!configPath) fail('usage: noydb-inspect <config.js|mjs> --vault=<name> [--passphrase=…]')
  const vaultFlag = argv.find((a) => a.startsWith('--vault='))
  if (!vaultFlag) fail('missing --vault=<name>')
  const vaultName = vaultFlag.slice('--vault='.length)

  const passphrase = resolvePassphrase(argv, process.env)
  if (passphrase === undefined) fail('no passphrase — pass --passphrase=… or set NOYDB_PASSPHRASE (interactive prompt: B2.1 follow-up)')

  let options: NoydbOptions
  try {
    options = (await loadOptionsFromFile(configPath!)) as NoydbOptions
  } catch (err) {
    fail(`failed to load config "${configPath}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const db = await createNoydb(options)
  let vault
  try {
    vault = await db.openVault(vaultName, { passphrase })
  } catch (err) {
    fail(`failed to open vault "${vaultName}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  const { waitUntilExit } = render(
    <App inspector={inspector} vault={vault} vaultName={vaultName} initial={initial} />,
  )
  await waitUntilExit()
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
```

> The masked interactive passphrase prompt (when neither flag nor env is set) is intentionally deferred — the bin currently errors with guidance. It is the first item of the B2.1 follow-up, kept out of this slice because a TTY-muted prompt has no clean unit test and the flag/env path covers CI + scripted use.

- [ ] **Step 2: typecheck + build + full package test**

Run: `pnpm --filter @noy-db/in-devtools-tui typecheck`
Expected: clean. (Confirm `openVault(name, { passphrase })` matches the hub signature; if the option key differs, adjust — verify against an existing hub test that opens a vault with a passphrase.)
Run: `pnpm --filter @noy-db/in-devtools-tui test`
Expected: PASS (5 tests).
Run: `pnpm --filter @noy-db/in-devtools-tui build`
Expected: tsup emits `dist/bin.js` with the `#!/usr/bin/env node` banner.

- [ ] **Step 3: Architecture check**

Run: `pnpm check:architecture`
Expected: PASS — `in-devtools-tui` peer-deps `@noy-db/hub` as `workspace:*` (check 1); no crypto deps (check 2). (ink/react are UI deps, not crypto.)

- [ ] **Step 4: Commit**

```bash
git add packages/in-devtools-tui/src/bin.tsx
git commit -m "feat(in-devtools-tui): bin boot flow — config + passphrase + openVault + render (Track B / B2.1)"
```

---

## Self-Review

**Spec coverage (B2.1):**
- Standalone package + `noydb-inspect` bin → Task 1. ✅
- ink/React, consumes only `@noy-db/in-devtools` → Tasks 1/3. ✅
- Boot flow (config-load → passphrase → openVault → createInspector → render) → Task 4. ✅
- Structure nav (vaults → collections → schema/stats; ↑/↓/↵/q) → Task 3 (App + panes + useInput). ✅
- Read-only + passphrase hygiene (only for openVault, flag/env, masked prompt deferred with guidance) → Tasks 2/4. ✅
- Tested via ink-testing-library (render frame + keypress) → Task 3; loader/passphrase unit-tested → Task 2. ✅
- Error handling (config/vault/passphrase failures exit before TUI) → Task 4 `fail()`. ✅

**Placeholder scan:** none. The deferred masked-prompt is explicitly out-of-scope with a working flag/env path + an error-with-guidance fallback, not a placeholder. The two "verify the signature" notes are concrete checks with the expected answer.

**Type consistency:** `App`/`AppProps`/`Focus`, `loadOptionsFromFile`/`resolvePassphrase`, pane prop names (`vaults`/`activeName`, `snapshot`/`selectedIdx`, `collection`), and the `initial = { vaults, snapshot }` shape are consistent across types.ts → panes → App → bin → tests. `Inspector`/`VaultInfo`/`InspectorSnapshot`/`InspectorCollection` imported from `@noy-db/in-devtools` (its public exports). ✅

---

## Follow-on

- **B2.1 tail:** masked interactive passphrase prompt (TTY-muted) when no flag/env.
- **B2.2:** records pane (paged `inspector.records`).
- **B2.3:** live-write feed (`inspector.subscribe`).
- Register `in-devtools-tui` in `features.yaml` once the surface stabilizes (the ink-testing-library test is the executable proof; a vitest "showcase" of a TUI is awkward — note this when registering).
