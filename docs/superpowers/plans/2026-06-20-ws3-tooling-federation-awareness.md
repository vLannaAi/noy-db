# WS-3 Tooling Federation-Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@noy-db`'s dev-tools, meter, and CLI operate on a federation `VaultGroup` by extracting a tiny type-only input contract in noy-db and building a group adapter + meter + CLI in klum-db — with no `@noy-db` package importing `@klum-db`.

**Architecture:** Two additive PRs across the published-package seam. PR-1 (noy-db) extracts `InspectableContainer` in `@noy-db/in-devtools` and narrows `createInspector` to it (a real `Noydb` still satisfies it). PR-2 (klum) adds a `groupInspector` adapter, a `meterGroup` fan-out, and a `klum` CLI bin — all conforming to the noy-owned contract, none importing klum into noy.

**Tech Stack:** TypeScript, pnpm workspaces + turbo (noy-db), single-package tsup + vitest (klum-db). Tests: vitest. In-memory store: `@noy-db/to-memory`.

**Spec:** `docs/superpowers/specs/2026-06-20-ws3-tooling-federation-awareness-design.md`

**Publish discipline:** the two "cut release" steps publish to npm and MUST NOT run without explicit user confirmation. Current versions: `@noy-db` `0.2.0-pre.25` → PR-1 lockstep bump to `pre.26`; `@klum-db/lobby` `0.2.0-pre.27` → PR-2 bump to `pre.28`.

---

## File Structure

**PR-1 — noy-db (`@noy-db/in-devtools`):**
- Modify: `packages/in-devtools/src/types.ts` — add `InspectableContainer` interface; repoint `InspectorNoydb` alias; adjust imports.
- Modify: `packages/in-devtools/src/index.ts` — narrow `createInspector` param; export `InspectableContainer`.
- Create: `packages/in-devtools/__tests__/inspectable-container.test.ts` — contract test.
- (Unchanged: `snapshot.ts`, `events.ts`, `records.ts`, `meter.ts` — they consume `InspectorNoydb`, which now resolves to the interface.)

**PR-2 — klum-db (`@klum-db/lobby`):**
- Modify: `package.json` — add `@noy-db/in-devtools` + `@noy-db/to-meter` peer+dev deps; add `bin`.
- Create: `src/federation/group-inspector.ts` — `groupInspector(group)` adapter.
- Create: `src/federation/meter-group.ts` — `meterGroup(group)` fan-out + report types.
- Create: `src/bin/klum.ts` — CLI (`inspect-group`, `meter-group`).
- Modify: `tsup.config.ts` — add the bin entry.
- Modify: `src/index.ts` — export the new group-tooling surface.
- Create: `__tests__/group-inspector.test.ts`, `__tests__/meter-group.test.ts`, `__tests__/cli.test.ts`, `__tests__/fixtures/group-config.ts`.

---

## PHASE 1 — noy-db PR-1: the `InspectableContainer` contract

Branch: `feat/in-devtools-inspectable-container` (off `main`).

### Task 1: Extract `InspectableContainer` and narrow `createInspector`

**Files:**
- Create: `packages/in-devtools/__tests__/inspectable-container.test.ts`
- Modify: `packages/in-devtools/src/types.ts`
- Modify: `packages/in-devtools/src/index.ts`

- [ ] **Step 1: Write the failing contract test**

`packages/in-devtools/__tests__/inspectable-container.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createInspector, type InspectableContainer } from '../src/index.js'
import type { Noydb } from '@noy-db/hub'

describe('InspectableContainer contract', () => {
  it('a real Noydb is assignable to InspectableContainer (compile-time proof)', () => {
    const asContainer = (n: Noydb): InspectableContainer => n
    expect(typeof asContainer).toBe('function')
  })

  it('createInspector accepts any structural InspectableContainer', () => {
    const container: InspectableContainer = {
      async listAccessibleVaults() {
        return []
      },
      async openVault() {
        throw new Error('not exercised by this test')
      },
      onAfterWrite() {
        return () => {}
      },
      onWriteConflict() {
        return () => {}
      },
      get writeQueue() {
        return { pending: false, depth: 0, onChange: () => () => {}, onFlush: async () => {} }
      },
    }
    const inspector = createInspector(container)
    expect(typeof inspector.listVaults).toBe('function')
    expect(inspector.pendingWrites()).toEqual({ pending: false, depth: 0 })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test inspectable-container`
Expected: FAIL — `InspectableContainer` is not exported from `../src/index.js`.

- [ ] **Step 3: Add the interface in `types.ts`**

In `packages/in-devtools/src/types.ts`, change the top import block to add `WriteHook`, `Unsubscribe`, `WriteQueue` and drop the now-unused `Noydb`:
```ts
import type {
  Vault,
  WriteEvent,
  WriteConflict,
  WriteHook,
  Unsubscribe,
  WriteQueue,
  AccessibleVault,
  CollectionDescriptor,
  CollectionStats,
} from '@noy-db/hub'
```
Replace the final `InspectorNoydb` alias (currently `export type InspectorNoydb = Noydb`) with:
```ts
/**
 * The container of vaults the inspector reads from. A `Noydb` satisfies this
 * verbatim; a klum `VaultGroup` adapter conforms structurally — so the inspector
 * works on a single instance OR a federation without importing either.
 */
export interface InspectableContainer {
  listAccessibleVaults(): Promise<readonly AccessibleVault[]>
  openVault(name: string): Promise<Vault>
  onAfterWrite(handler: WriteHook): Unsubscribe
  onWriteConflict(handler: (c: WriteConflict) => void): Unsubscribe
  readonly writeQueue: WriteQueue
}

/** @deprecated renamed to {@link InspectableContainer}. */
export type InspectorNoydb = InspectableContainer
```

- [ ] **Step 4: Narrow `createInspector` and export the interface in `index.ts`**

In `packages/in-devtools/src/index.ts`, change the import on line 2 to pull `InspectableContainer` and update the signature + delegate var name:
```ts
import type { Inspector, InspectableContainer, InspectorMeter } from './types.js'
// ...
export function createInspector(container: InspectableContainer, opts?: { meter?: InspectorMeter }): Inspector {
  return {
    listVaults: () => listVaults(container),
    snapshot: (vault: Vault) => snapshot(vault),
    records: (vault, collection, opts) => records(vault, collection, opts),
    subscribe: (handler) => subscribe(container, handler),
    subscribeConflicts: (handler) => subscribeConflicts(container, handler),
    pendingWrites: () => pendingWrites(container),
    meterSnapshot: () => meterSnapshot(opts?.meter),
  }
}
```
Add `InspectableContainer` to the `export type { … } from './types.js'` block (keep `InspectorNoydb` out of the public list — it stays an internal deprecated alias).
(No change to `snapshot.ts`/`events.ts`: they take `noydb: InspectorNoydb`, which now resolves to the interface; every method they call — `listAccessibleVaults`, `onAfterWrite`, `onWriteConflict`, `writeQueue` — is on it.)

- [ ] **Step 5: Run the contract test, verify it passes**

Run: `pnpm --filter @noy-db/in-devtools test inspectable-container`
Expected: PASS (both cases).

- [ ] **Step 6: Prove backward-compat — run the full in-devtools + TUI suites**

Run: `pnpm --filter @noy-db/in-devtools --filter @noy-db/in-devtools-tui test`
Expected: PASS, unchanged counts plus the 2 new cases. (The TUI passes a real `Noydb` to `createInspector` — it still type-checks.)

- [ ] **Step 7: Typecheck, lint, architecture guard**

Run: `pnpm --filter @noy-db/in-devtools typecheck && pnpm --filter @noy-db/in-devtools lint && pnpm check:architecture`
Expected: all green (guard confirms no `@klum-db` import crept in).

- [ ] **Step 8: Commit**

```bash
git add packages/in-devtools/src/types.ts packages/in-devtools/src/index.ts packages/in-devtools/__tests__/inspectable-container.test.ts
git commit -m "feat(in-devtools): InspectableContainer contract — createInspector accepts any container of vaults"
```

### Task 2: Lockstep version bump + release PR (publish gated on user confirmation)

**Files:** every `packages/*/package.json` currently at `0.2.0-pre.25` (version field only).

- [ ] **Step 1:** Bump all `@noy-db/*` packages + `create-noy-db` from `0.2.0-pre.25` → `0.2.0-pre.26` (version field only; skip private packages not on the pre.N line). Reuse the established bump script pattern.
- [ ] **Step 2:** Commit `chore(release): 0.2.0-pre.26 — in-devtools InspectableContainer (WS-3 part A)`, push branch, open PR to `main`.
- [ ] **Step 3:** After CI green and **explicit user confirmation**, merge and cut the GitHub prerelease (`--target <full-sha>`, prerelease → `@next`). `release.yml` verifies + publishes `@noy-db/*` + `create-noy-db`.
- [ ] **Step 4:** Verify on npm: `npm view @noy-db/in-devtools@0.2.0-pre.26 version` resolves; the package's types include `InspectableContainer`.

---

## PHASE 2 — klum-db PR-2: adapter + meter + CLI

Branch: `feat/federation-tooling` (off klum-db `main`). All paths below are in `/Users/vicio/_github/klum-db`. Build against the **published** `@noy-db@0.2.0-pre.26` from Phase 1.

### Task 3: Add dependencies

**Files:** `package.json`

- [ ] **Step 1:** Add to `peerDependencies`: `"@noy-db/in-devtools": "^0.2.0-pre.26"`, `"@noy-db/to-meter": "^0.2.0-pre.26"`. Add the same two to `devDependencies` pinned at `0.2.0-pre.26`.
- [ ] **Step 2:** `pnpm install` (or the repo's install command). Expected: resolves, no peer warnings for these two.
- [ ] **Step 3:** Commit `chore(deps): add @noy-db/in-devtools + @noy-db/to-meter for federation tooling`.

### Task 4: `groupInspector` adapter

**Files:**
- Create: `src/federation/group-inspector.ts`
- Test: `__tests__/group-inspector.test.ts`
- Modify: `src/index.ts` (barrel export)

- [ ] **Step 1: Write the failing test**

`__tests__/group-inspector.test.ts` — build a 2-shard group (mirror the setup in `__tests__/federation-vault-group.test.ts`: a `to-memory` store, a Lobby with a registered vault template, `openVaultGroup` with a `keyOf` sharding config), write a record to two partitions (auto-creating two shards), then:
```ts
import { describe, it, expect } from 'vitest'
import { createInspector } from '@noy-db/in-devtools'
import { groupInspector } from '../src/federation/group-inspector.js'
// + the existing federation test's group-setup helper

describe('groupInspector', () => {
  it('drives createInspector over a federation: lists shards, snapshots one, scopes write events', async () => {
    const { group, db } = await makeTwoShardGroup() // helper mirroring federation-vault-group.test.ts
    const inspector = createInspector(groupInspector(group))

    const vaults = await inspector.listVaults()
    expect(vaults.length).toBe(2)
    expect(vaults.every((v) => v.role === 'owner')).toBe(true)

    const shard = await group.shard('alice') // a real Vault
    const snap = await inspector.snapshot(shard)
    expect(snap.collections.map((c) => c.name)).toContain('orders')

    // write-event scoping: a write to a NON-group vault must NOT fire
    const seen: string[] = []
    const unsub = inspector.subscribe((e) => seen.push(e.vault))
    const outsider = await db.openVault('not-in-group', { create: true })
    await outsider.collection('x').put('1', { id: '1' })
    const shardVault = await group.shard('bob')
    await shardVault.collection('orders').put('o9', { id: 'o9' })
    await new Promise((r) => setTimeout(r, 10))
    unsub()
    expect(seen).toContain(shardVault === shard ? 'alice' : (await group.allRows()).find((r) => r.partitionKey === 'bob')!.vaultId)
    expect(seen).not.toContain('not-in-group')
  })
})
```
(The implementer adapts `makeTwoShardGroup` from the existing federation test; the exact collection name `orders` follows that fixture's template.)

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test group-inspector` — FAIL (`groupInspector` not found).

- [ ] **Step 3: Implement the adapter**

`src/federation/group-inspector.ts`:
```ts
import type { InspectableContainer } from '@noy-db/in-devtools'
import type { AccessibleVault, Vault, WriteHook, WriteConflict, WriteQueue, Unsubscribe } from '@noy-db/hub'
import type { VaultGroup } from './vault-group.js'

/**
 * Adapt a federation VaultGroup to the dev-tools InspectableContainer contract.
 * Built entirely on VaultGroup's public surface (`allRows`, `db`, `template`) —
 * no VaultGroup changes, and no @klum import lands in any @noy-db package.
 */
export function groupInspector(group: VaultGroup<unknown>): InspectableContainer {
  // Group-scoped shard ids for write-event filtering; refreshed on every list.
  let shardIds = new Set<string>()
  const refresh = async () => {
    const rows = await group.allRows()
    shardIds = new Set(rows.map((r) => r.vaultId))
    return rows
  }
  return {
    async listAccessibleVaults(): Promise<readonly AccessibleVault[]> {
      const rows = await refresh()
      return rows.map((r): AccessibleVault => ({ id: r.vaultId, role: 'owner' }))
    },
    async openVault(name: string): Promise<Vault> {
      const vault = await group.db.openVault(name)
      group.template.configure(vault)
      return vault
    },
    onAfterWrite(handler: WriteHook): Unsubscribe {
      return group.db.onAfterWrite((event) => {
        if (shardIds.has(event.vault)) return handler(event)
      })
    },
    onWriteConflict(handler: (c: WriteConflict) => void): Unsubscribe {
      return group.db.onWriteConflict((c) => {
        if (shardIds.has(c.vault)) handler(c)
      })
    },
    get writeQueue(): WriteQueue {
      return group.db.writeQueue
    },
  }
}
```
Note: callers should `await listAccessibleVaults()` before relying on write-event scoping (it primes `shardIds`); the inspector's normal flow calls `listVaults()` first. Document this on the function.

- [ ] **Step 4: Export from the barrel**

In `src/index.ts`, add to the appropriate section:
```ts
export { groupInspector } from './federation/group-inspector.js'
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm test group-inspector` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/federation/group-inspector.ts src/index.ts __tests__/group-inspector.test.ts
git commit -m "feat(federation): groupInspector — drive @noy-db/in-devtools over a VaultGroup"
```

### Task 5: `meterGroup` fan-out

**Files:**
- Create: `src/federation/meter-group.ts`
- Test: `__tests__/meter-group.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

`__tests__/meter-group.test.ts` — build a 2-shard group, put N records across two partitions, assert:
```ts
import { describe, it, expect } from 'vitest'
import { meterGroup } from '../src/federation/meter-group.js'

describe('meterGroup', () => {
  it('sums shape-metrics across eligible shards and surfaces skipped', async () => {
    const { group } = await makeTwoShardGroup() // same helper as Task 4
    // put 2 orders under 'alice', 1 under 'bob' (auto-creates both shards)
    await group.collection('orders').put('a1', { id: 'a1', customer: 'alice' })
    await group.collection('orders').put('a2', { id: 'a2', customer: 'alice' })
    await group.collection('orders').put('b1', { id: 'b1', customer: 'bob' })

    const report = await meterGroup(group)
    expect(report.vaults).toBe(2)
    expect(report.records).toBe(3)
    expect(report.perShard.reduce((n, s) => n + s.records, 0)).toBe(3)
    expect(report.skipped).toEqual([])
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `pnpm test meter-group` → FAIL.

- [ ] **Step 3: Implement**

`src/federation/meter-group.ts`:
```ts
import type { VaultGroup } from './vault-group.js'
import type { SkippedVault } from './types.js'

export interface GroupShardMetrics {
  readonly vaultId: string
  readonly partitionKey: string
  readonly schemaVersion: number
  readonly collections: number
  readonly records: number
}

export interface GroupMeterReport {
  readonly vaults: number
  readonly collections: number // distinct collection names across the group
  readonly records: number // summed across shards
  readonly perShard: ReadonlyArray<GroupShardMetrics>
  readonly skipped: ReadonlyArray<SkippedVault>
}

/**
 * Fan shape-metrics (collections + record counts) across the group's ELIGIBLE
 * shards. Drifted / provisioning-failed shards are surfaced in `skipped`, never
 * counted or silently dropped. Reuses the per-vault pattern from multi-bundle.ts.
 */
export async function meterGroup(
  group: VaultGroup<unknown>,
  opts: { minVersion?: number } = {},
): Promise<GroupMeterReport> {
  const { eligible, skipped } = await group.resolveEligible({ minVersion: opts.minVersion })
  const perShard: GroupShardMetrics[] = []
  const names = new Set<string>()
  let records = 0
  for (const row of eligible) {
    const vault = await group.shard(row.partitionKey)
    const collNames = await vault.collections()
    let shardRecords = 0
    for (const n of collNames) {
      names.add(n)
      shardRecords += await vault.collection(n).count()
    }
    records += shardRecords
    perShard.push({
      vaultId: row.vaultId,
      partitionKey: row.partitionKey,
      schemaVersion: row.schemaVersion,
      collections: collNames.length,
      records: shardRecords,
    })
  }
  return { vaults: eligible.length, collections: names.size, records, perShard, skipped }
}
```

- [ ] **Step 4: Export** — in `src/index.ts`:
```ts
export { meterGroup } from './federation/meter-group.js'
export type { GroupMeterReport, GroupShardMetrics } from './federation/meter-group.js'
```

- [ ] **Step 5: Run, verify it passes** — `pnpm test meter-group` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/federation/meter-group.ts src/index.ts __tests__/meter-group.test.ts
git commit -m "feat(federation): meterGroup — group-wide shape metrics across eligible shards"
```

### Task 6: `klum` CLI bin

**Files:**
- Create: `src/bin/klum.ts`
- Create: `__tests__/fixtures/group-config.ts`
- Test: `__tests__/cli.test.ts`
- Modify: `tsup.config.ts`, `package.json`

- [ ] **Step 1: Write the failing test**

`__tests__/fixtures/group-config.ts` — a config module default-exporting a factory that builds an in-memory 2-shard group and returns it:
```ts
import type { VaultGroup } from '../../src/federation/vault-group.js'
export default async function openGroup(_groupName?: string): Promise<VaultGroup<unknown>> {
  const { group } = await makeTwoShardGroup() // inline the federation-test setup here
  await group.collection('orders').put('a1', { id: 'a1', customer: 'alice' })
  return group
}
```
`__tests__/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseArgs, main } from '../src/bin/klum.js'

describe('klum CLI', () => {
  it('parseArgs reads command, config, --group, --vault, --meter', () => {
    expect(parseArgs(['inspect-group', './c.js', '--group=g', '--vault=v1', '--meter'])).toEqual({
      command: 'inspect-group',
      configPath: './c.js',
      group: 'g',
      vault: 'v1',
      meter: true,
    })
  })

  it('inspect-group lists the group shards', async () => {
    const lines: string[] = []
    const code = await main(
      ['inspect-group', new URL('./fixtures/group-config.js', import.meta.url).pathname, '--group=g'],
      (s) => lines.push(s),
    )
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/1 shard|alice/i)
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `pnpm test cli` → FAIL (`../src/bin/klum.js` missing).

- [ ] **Step 3: Implement the CLI**

`src/bin/klum.ts`:
```ts
import { createInspector } from '@noy-db/in-devtools'
import { groupInspector } from '../federation/group-inspector.js'
import { meterGroup } from '../federation/meter-group.js'
import type { VaultGroup } from '../federation/vault-group.js'

type GroupFactory = (groupName?: string) => Promise<VaultGroup<unknown>>
type Log = (s: string) => void

export interface ParsedArgs {
  command: string
  configPath?: string
  group?: string
  vault?: string
  meter: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { command: argv[0] ?? '', meter: false }
  for (const a of argv.slice(1)) {
    if (a.startsWith('--group=')) out.group = a.slice(8)
    else if (a.startsWith('--vault=')) out.vault = a.slice(8)
    else if (a === '--meter') out.meter = true
    else if (!a.startsWith('--')) out.configPath = a
  }
  return out
}

async function loadGroup(args: ParsedArgs): Promise<VaultGroup<unknown>> {
  const mod = (await import(args.configPath!)) as { default: GroupFactory }
  return mod.default(args.group)
}

export async function runInspectGroup(args: ParsedArgs, log: Log): Promise<number> {
  if (!args.configPath) {
    log('usage: klum inspect-group <config> --group=<name> [--vault=<id>]')
    return 2
  }
  const group = await loadGroup(args)
  const inspector = createInspector(groupInspector(group))
  const vaults = await inspector.listVaults()
  log(`group "${args.group ?? ''}" — ${vaults.length} shard(s):`)
  for (const v of vaults) log(`  ${v.id} [${v.role}]`)
  if (args.vault) {
    const vault = await group.db.openVault(args.vault)
    group.template.configure(vault)
    const snap = await inspector.snapshot(vault)
    log(`  collections in ${args.vault}: ${snap.collections.map((c) => c.name).join(', ')}`)
  }
  return 0
}

export async function runMeterGroup(args: ParsedArgs, log: Log): Promise<number> {
  if (!args.configPath) {
    log('usage: klum meter-group <config> --group=<name>')
    return 2
  }
  const group = await loadGroup(args)
  const r = await meterGroup(group)
  log(`group "${args.group ?? ''}" — ${r.vaults} vault(s), ${r.collections} collection(s), ${r.records} record(s)`)
  for (const s of r.perShard) log(`  ${s.vaultId} (${s.partitionKey}) v${s.schemaVersion}: ${s.collections} coll, ${s.records} rec`)
  if (r.skipped.length) log(`  skipped: ${r.skipped.length} shard(s)`)
  return 0
}

export async function main(argv: readonly string[], log: Log = console.log): Promise<number> {
  const args = parseArgs(argv)
  switch (args.command) {
    case 'inspect-group':
      return runInspectGroup(args, log)
    case 'meter-group':
      return runMeterGroup(args, log)
    default:
      log('klum <inspect-group|meter-group> <config> --group=<name> [--vault=<id>]')
      return args.command ? 1 : 0
  }
}

// bin entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
}
```
(Scoping note: the `--meter` flag is parsed but operational-store wrapping via `toMeter` is **deferred** — the CLI receives an already-built group, so operational metering is a config-factory opt-in. `meter-group` covers shape metrics. Record this as a follow-up; do not build `--meter` wrapping in this task.)

- [ ] **Step 4: Wire the bin into the build**

In `tsup.config.ts`, add `'src/bin/klum.ts'` to the `entry` array. In `package.json`, add:
```json
"bin": { "klum": "dist/bin/klum.js" }
```

- [ ] **Step 5: Run the test, verify it passes** — `pnpm test cli` → PASS.

- [ ] **Step 6: Build + full suite + typecheck + lint**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green; `dist/bin/klum.js` emitted.

- [ ] **Step 7: Commit**
```bash
git add src/bin/klum.ts __tests__/cli.test.ts __tests__/fixtures/group-config.ts tsup.config.ts package.json
git commit -m "feat(cli): klum bin — inspect-group + meter-group over a federation"
```

### Task 7: Version bump + release PR (publish gated on user confirmation)

- [ ] **Step 1:** Bump `@klum-db/lobby` `0.2.0-pre.27` → `0.2.0-pre.28`.
- [ ] **Step 2:** Commit `chore(release): 0.2.0-pre.28 — federation tooling (WS-3)`, push, open PR.
- [ ] **Step 3:** After CI green + **explicit user confirmation**, merge + cut the klum prerelease (`@next`). Confirm provenance publish from the klum repo.
- [ ] **Step 4:** Verify on npm: `npm view @klum-db/lobby@0.2.0-pre.28 version`; `groupInspector` / `meterGroup` in the published types; the `klum` bin present.

---

## Self-Review

**Spec coverage:** Part A (contract) → Task 1. Part B (adapter) → Task 4. Part C (meter) → Task 5 (+ operational-meter documented as already group-wide; the CLI surfaces shape metrics). Part D (CLI) → Task 6. Publish sequencing (noy PR-1 → klum PR-2) → Tasks 2 & 7. Deferred group-TUI → not in plan (matches spec). `--meter` operational wrapping → explicitly deferred in Task 6 note (a scoped simplification of the spec's optional sugar).

**Type consistency:** `InspectableContainer` members match the verbatim public hub types (`AccessibleVault`, `Vault`, `WriteHook`, `Unsubscribe`, `WriteConflict`, `WriteQueue`); the klum adapter implements exactly those; `meterGroup` uses `resolveEligible`→`{eligible,skipped}` and `shard(pk)`→`Vault`→`collections()`/`collection(n).count()` (verified public). `WriteEvent.vault` / `WriteConflict.vault` exist (verified) so the scoping filter compiles.

**Placeholder scan:** the test helper `makeTwoShardGroup` is referenced, not inlined — it is an adaptation of the existing `__tests__/federation-vault-group.test.ts` setup; the implementer copies that fixture. This is the one intentional "adapt existing fixture" reference; every novel module ships complete code above.
