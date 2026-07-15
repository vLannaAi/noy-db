#!/usr/bin/env node
/**
 * Architecture invariant checks. Run via `pnpm check:architecture`.
 *
 * Each check enforces one rule from the project's design contract.
 * Failures are collected and reported in a single pass so authors see
 * every violation in one CI run instead of one-at-a-time fix-and-retry.
 *
 * Checks today:
 *
 *   1. peer-deps      — every @noy-db satellite uses
 *                       `peerDependencies['@noy-db/hub'] = "workspace:*"`
 *                       (NOT "workspace:^", NOT in dependencies).
 *
 *   2. no-crypto-deps — no npm crypto packages anywhere in the
 *                       workspace. The library uses `crypto.subtle`
 *                       (Web Crypto API) exclusively.
 *
 *   3. hub-portable   — `packages/hub/src/**` does not import any
 *                       Node-only module. The hub must run unchanged
 *                       in browsers, Workers, Bun, Deno, and Node.
 *
 *   4. stores-ciphertext-only
 *                     — packages under `to-*` do not import any
 *                       crypto primitive from `@noy-db/hub`. Stores
 *                       only ever see encrypted envelopes.
 *
 *   5. strategy-opt-in
 *                     — every file that constructs its own Noydb
 *                       (calls `createNoydb({...})`) AND uses a
 *                       strategy-gated API on the resulting vault
 *                       (e.g. `vault.dump()`, `vault.ledger()`,
 *                       `vault.dictionary()`) must also reference
 *                       the corresponding `with*()` factory.
 *                       Closes #299 (vault.dump() needs withHistory)
 *                       and #300 (test-fixture strategy audit).
 *
 *   6. kernel-surface — the always-on orchestration files
 *                       (collection.ts / vault.ts / noydb.ts) must stay
 *                       under a declared line ceiling. A ratchet: it locks
 *                       in Track A's kernel shrink so services register
 *                       on the SubsystemBus instead of hard-coding into
 *                       these files. See KERNEL_SURFACE_BUDGET.
 *
 *   11. enclave-body-only — non-enclave `packages/hub/src/**` may not read
 *                       or construct the envelope's protected-body fields
 *                       (`_iv`/`_data`/`_cek`/`_det`/`_sealed`) directly;
 *                       only `kernel/enclave/**` may. A per-file grandfather
 *                       map (PRE_EXISTING_BODY_ACCESS) ratchets the count
 *                       down as call-sites migrate onto the barrel helpers —
 *                       stored count must always equal actual, in both
 *                       directions.
 *
 * Each check has its own per-package or per-file allow-list when a
 * legitimate exception exists.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PACKAGES_DIR = join(ROOT, 'packages')

// ─── Reporting ─────────────────────────────────────────────────────────

const failures = []

function fail(check, message, where) {
  failures.push({ check, message, where: where ? relative(ROOT, where) : '' })
}

// ─── Helpers ───────────────────────────────────────────────────────────

function listPackageDirs() {
  return readdirSync(PACKAGES_DIR)
    .map(d => join(PACKAGES_DIR, d))
    .filter(p => statSync(p).isDirectory())
    .filter(p => existsSync(join(p, 'package.json')))
}

function readPackageJson(pkgDir) {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
}

function walkTsFiles(dir, onFile) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walkTsFiles(full, onFile)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.d.ts')) continue
    onFile(full, readFileSync(full, 'utf8'))
  }
}

/**
 * Strip JSDoc + line comments before scanning so import-pattern checks
 * don't trip on code shown inside `@example` blocks. Not a full parser
 * — but the only thing we care about is "could this line plausibly be
 * an actual import," and code-in-comments doesn't fit that bill.
 */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */ and /** ... */
    .replace(/^\s*\/\/.*$/gm, '')       // // line comments
}

/**
 * Stronger strip used by checks that scan for method-call shapes —
 * also removes string-literal contents so a substring like
 * `"vault.dictionary(...)"` inside an error message doesn't read as
 * an actual call. Replaces the body of strings with spaces (preserves
 * line numbers + structure for any later reporting).
 */
function stripCommentsAndStrings(content) {
  let s = stripComments(content)
  // Template literals (backticks) — handle ${...} interpolations by
  // keeping their interiors (they ARE code) and only blanking the
  // surrounding text. Cheaper proxy: blank everything inside backticks
  // including `${...}`. False negative on calls that ONLY appear
  // inside template-interpolated code is acceptable — template-literal
  // call sites are a rare path.
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``')
  // Single + double quoted strings.
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''")
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""')
  return s
}

// ─── Check 1: peer-dep convention ──────────────────────────────────────

function checkPeerDeps() {
  for (const pkgDir of listPackageDirs()) {
    const pj = readPackageJson(pkgDir)
    if (!pj.name) continue
    // Only @noy-db satellites need to peer-dep on hub. Hub itself doesn't
    // depend on hub.
    if (!pj.name.startsWith('@noy-db/')) continue
    if (pj.name === '@noy-db/hub') continue

    const dep = pj.dependencies?.['@noy-db/hub']
    const peer = pj.peerDependencies?.['@noy-db/hub']

    // Hub-as-a-runtime-dep is always wrong — it forces a hub copy into
    // the satellite's install tree and breaks cross-subpath
    // `instanceof` checks.
    if (dep !== undefined) {
      fail(
        'peer-deps',
        `${pj.name} has @noy-db/hub in dependencies (= ${JSON.stringify(dep)}). It must be peerDependencies only.`,
        pkgDir,
      )
    }

    // If the package declares a peer on hub, the constraint must be
    // `workspace:*` exactly — `workspace:^` trips the changeset-cli
    // pre-1.0 dep-propagation heuristic and forces unintended major
    // bumps on every dependent.
    if (peer !== undefined && peer !== 'workspace:*') {
      fail(
        'peer-deps',
        `${pj.name} has peerDependencies['@noy-db/hub'] = ${JSON.stringify(peer)}, expected "workspace:*".`,
        pkgDir,
      )
    }
    // Packages with no peer declaration AT ALL are allowed (e.g., a
    // future utility that's pure types). The dependencies check above
    // is what stops the wrong-section pattern.
  }
}

// ─── Check 2: zero npm crypto deps ─────────────────────────────────────

const BANNED_CRYPTO_DEPS = new Set([
  'crypto-js',
  'node-forge',
  'tweetnacl',
  'tweetnacl-util',
  'bcrypt',
  'bcryptjs',
  'argon2',
  'argon2-browser',
  'scrypt',
  'scrypt-js',
  'libsodium',
  'libsodium-wrappers',
  'libsodium-wrappers-sumo',
  'pbkdf2',
  'aes-js',
  'elliptic',
  'js-sha256',
  'js-sha512',
  'js-md5',
  'sjcl',
  'create-hash',
  'create-hmac',
  'browserify-aes',
])

const BANNED_CRYPTO_SCOPES = ['@noble/', '@scure/']

function isBannedCryptoDep(name) {
  if (BANNED_CRYPTO_DEPS.has(name)) return true
  if (BANNED_CRYPTO_SCOPES.some(scope => name.startsWith(scope))) return true
  return false
}

function checkNoCryptoDeps() {
  for (const pkgDir of listPackageDirs()) {
    const pj = readPackageJson(pkgDir)
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    for (const section of sections) {
      const deps = pj[section] ?? {}
      for (const name of Object.keys(deps)) {
        if (isBannedCryptoDep(name)) {
          fail(
            'no-crypto-deps',
            `${pj.name ?? pkgDir} declares "${name}" in ${section}. The project has a zero-crypto-dependency invariant — use the Web Crypto API (crypto.subtle) instead.`,
            pkgDir,
          )
        }
      }
    }
  }
}

// ─── Check 3: hub stays portable ───────────────────────────────────────

const NODE_BUILTIN_PATTERNS = [
  /from\s+['"]node:fs(\/promises)?['"]/,
  /from\s+['"]node:path['"]/,
  /from\s+['"]node:os['"]/,
  /from\s+['"]node:crypto['"]/,
  /from\s+['"]node:url['"]/,
  /from\s+['"]node:process['"]/,
  /from\s+['"]node:child_process['"]/,
  /from\s+['"]node:net['"]/,
  /from\s+['"]node:tls['"]/,
  /from\s+['"]node:stream['"]/,
  /from\s+['"]node:dns['"]/,
  /from\s+['"]node:buffer['"]/,
  /from\s+['"]node:worker_threads['"]/,
  // Bare-name forms (older style; some projects still use them).
  /from\s+['"]fs(\/promises)?['"]/,
  /from\s+['"]path['"]/,
  /from\s+['"]os['"]/,
  /from\s+['"]crypto['"]/,
  /from\s+['"]child_process['"]/,
]

function checkHubPortable() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  walkTsFiles(hubSrc, (file, content) => {
    const code = stripComments(content)
    for (const re of NODE_BUILTIN_PATTERNS) {
      if (re.test(code)) {
        fail(
          'hub-portable',
          `${relative(ROOT, file)} imports a Node-only module (matched ${re}). The hub must run unchanged in browsers, Workers, Bun, Deno, and Node — Node-only code belongs in to-* / cli / scripts.`,
          file,
        )
        break
      }
    }
  })
}

// ─── Check 4: stores never see plaintext ───────────────────────────────

const BANNED_STORE_NAMED_IMPORTS = new Set([
  'encrypt',
  'decrypt',
  'encryptBytes',
  'decryptBytes',
  'encryptBytesWithAAD',
  'decryptBytesWithAAD',
  'encryptDeterministic',
  'decryptDeterministic',
  'wrapKey',
  'unwrapKey',
  'deriveKey',
  'generateDEK',
  'generateSalt',
])

const NAMED_IMPORT_RE =
  /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]@noy-db\/hub(?:\/[^'"]+)?['"]/g

function checkStoresCiphertextOnly() {
  for (const pkgDir of listPackageDirs()) {
    const pj = readPackageJson(pkgDir)
    if (!pj.name?.startsWith('@noy-db/to-')) continue

    const srcDir = join(pkgDir, 'src')
    walkTsFiles(srcDir, (file, content) => {
      const code = stripComments(content)
      let match
      // Reset regex state for each file.
      const re = new RegExp(NAMED_IMPORT_RE.source, 'g')
      while ((match = re.exec(code)) !== null) {
        const wholeImportIsTypeOnly = Boolean(match[1])
        if (wholeImportIsTypeOnly) continue

        const inner = match[2]
        const names = inner
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => {
            // Drop per-binding `type ` prefix — type imports are fine.
            if (s.startsWith('type ')) return null
            // `something as alias` → take the source name.
            return s.split(/\s+as\s+/)[0].trim()
          })
          .filter(Boolean)

        for (const name of names) {
          if (BANNED_STORE_NAMED_IMPORTS.has(name)) {
            fail(
              'stores-ciphertext-only',
              `${pj.name}: ${relative(ROOT, file)} imports "${name}" from @noy-db/hub. Stores must only handle ciphertext envelopes — crypto primitives belong inside the hub.`,
              file,
            )
          }
        }
      }
    })
  }
}

// ─── Check 5: strategy-opt-in (closes #299, #300) ──────────────────────

/**
 * APIs that throw without their backing strategy. Each tuple is
 * [API call pattern, strategy option key, factory name]. A file that
 * matches the pattern AND calls `createNoydb(...)` AND references
 * neither the option key nor the factory name fails the check.
 *
 * Patterns are deliberately distinctive — generic names (`.at`,
 * `.aggregate`, `.frame`) are excluded because they collide with
 * unrelated code (Date.at, Array.aggregate, animation frames).
 * Coverage today: 5 of the 12 strategy seams. The five chosen are
 * the ones with unique-enough method names AND realistic
 * production / test footprint.
 */
const STRATEGY_GATED_APIS = [
  { api: /\.dump\s*\(/,        option: 'historyStrategy', factory: 'withHistory' },
  { api: /\.ledger\s*\(\s*\)/, option: 'historyStrategy', factory: 'withHistory' },
  { api: /\.dictionary\s*\(/,  option: 'i18nStrategy',    factory: 'withI18n' },
  { api: /\.lazyQuery\s*\(/,   option: 'indexStrategy',   factory: 'withIndexing' },
  { api: /\.exportBlobs\s*\(/, option: 'blobStrategy',    factory: 'withBlobs' },
  { api: /\.broker\s*\(\s*\)/, option: 'brokerStrategy',  factory: 'withBroker' },
]

// Per-file exceptions: files that legitimately invoke a gated API
// on a NON-vault surface (e.g., throw-stub assertions on overlay
// virtual collections, where the method is named to match Collection<T>
// but always throws regardless of indexStrategy).
const STRATEGY_OPT_IN_EXEMPT = new Set([
  'packages/hub/__tests__/overlay-views/overlay.test.ts',
])

function checkStrategyOptIns() {
  for (const pkgDir of listPackageDirs()) {
    walkTsFiles(join(pkgDir, 'src'), scanFileForStrategyOptIn)
    walkTsFiles(join(pkgDir, '__tests__'), scanFileForStrategyOptIn)
  }
}

function scanFileForStrategyOptIn(file, content) {
  // Type-only tests (`*.test-d.ts`) are consumed by tsc and NEVER executed, so
  // the runtime "gated API throws without its strategy" hazard this check guards
  // against cannot occur in them. Skip the whole class (covers any current/future
  // type-test that references a gated API like `.lazyQuery()` for type assertions).
  if (file.endsWith('.test-d.ts')) return
  if (STRATEGY_OPT_IN_EXEMPT.has(relative(ROOT, file))) return
  // Use the stronger strip — error-message strings legitimately mention
  // method names like ".dictionary()" inside hint text, which the
  // comment-only strip would leave intact and trip false positives.
  const code = stripCommentsAndStrings(content)
  // The check fires only on files that both construct a Noydb in-line
  // AND call a gated API. Files that only consume an injected Vault
  // are out of scope — the opt-in lives at the construction site.
  if (!/\bcreateNoydb\s*\(/.test(code)) return

  for (const { api, option, factory } of STRATEGY_GATED_APIS) {
    if (!api.test(code)) continue
    if (code.includes(option)) continue
    if (code.includes(factory)) continue
    fail(
      'strategy-opt-in',
      `${relative(ROOT, file)} calls createNoydb(...) and uses a ${option}-gated API (matched ${api}), but never references ${option} or ${factory}. Pass \`${option}: ${factory}()\` to createNoydb, otherwise the API will throw at runtime.`,
      file,
    )
  }
}

// ─── Check 5b: every service ships a withX() gate ──────────────────────
//
// The STRUCTURAL companion to the per-file scan above. That scan checks
// that a consumer references `withX()`; this one guarantees the withX()
// actually exists — i.e. every archetype-①/② service folder under
// packages/hub/src/with-*/ ships an opt-in gate. Without it a service
// could quietly go always-on (no factory at all) and the per-file scan
// would never fire because there'd be nothing to look for.
//
// Rule: every `with-<dim>/<service>/` sub-folder — and every `with-<dim>`
// dim that has NO sub-folders (the dim IS the service, e.g. with-cargo) —
// must export a `with*()` factory, UNLESS it is on the exempt list below.
// `via/` (the Via port's non-`with-*` service root, e.g. via/money)
// is scanned the same way as a `with-<dim>` namespace dim (#623).
//
// Exemptions (verified 2026-07-02) fall in three buckets:
//   ③ schema features — declared on `collection({ … })`, not a global
//     strategy; the collection IS the opt-in unit, impl lazy-imported
//     from the schema declaration (see noy-db-docs/content/docs/services/<x>.md):
//       with-formula/computed          computed({…}) field evaluator
//       via/classified                 classifiedFields declaration (sealed + riders)
//       with-shape/introspection       describe()/dumpVaultSchema — read-only schema surface
//       with-shape/links               link()/backlink schema refs
//       via/money                      money() field descriptor
//       with-shape/persisted-schemas   schema-persistence infra behind collection()
//       with-shape/schema-update       per-collection migration strategies
//   always-on infra — no discrete capability to gate:
//       with-party/directory           user directory; defaults ON, called unconditionally in core keyring flows
//       with-party/policy              policy gate engine; every vault always gets policy enforcement, no strategy option to opt out of
//       with-pod                       writeNoydbBundle/vault.dump — internal backup primitive used by snapshots/portability/cargo/backup
//   sub-parts of an already-gated service (covered by another withX):
//       with-lookup/embeddings         vector compute folded into withSearch()
//       with-party/sync                sync impl behind team's withSync()
//       with-party/auth-introspection  read-only describe/diagram surface (no instance to gate)
//
// NOTE — the ungated host-side free-function carve-outs (openSealedRecord,
// adoptPartition, decryptExtractedPartition, liberateVault, diffVault) take
// raw bytes / are shared import-merge infra with no live vault instance to
// gate, so they intentionally have no withX(). They aren't their own
// with-* service folder, so this scan never sees them — noted here for the
// reader who wonders why they're absent from the list.
const SCHEMA_DECLARED_OR_INFRA_EXEMPT = new Set([
  'with-formula/computed',
  'via/classified',
  'with-shape/introspection',
  'with-shape/links',
  'via/money',
  'with-shape/persisted-schemas',
  'with-shape/schema-update',
  // #591 satellites — satelliteOf/fields/joined declaration on collection(); joined handle via vault.joined()
  'with-shape/satellites',
  'with-party/directory',
  'with-party/policy',
  'with-pod',
  'with-lookup/embeddings',
  'with-party/sync',
  'with-party/auth-introspection',
  // #629 Task 7 — withBlobs() gate moved to via/blob; this folder is the
  // gated service's content-crypto machinery (BlobSet/compaction/export), same
  // bucket as with-party/sync behind team's withSync().
  'with-shape/blobs',
  // #638 Task 7 — computed() is a declaration factory (money()/i18nText() precedent,
  // same ③ schema-feature bucket as via/money/with-formula/computed above), not
  // an opt-in strategy gate; the computed via-binder links eagerly (port/with/computed-strategy.ts).
  'via/computed',
])

// Does any .ts file in `dir` (recursively) export a `with*()` factory —
// as a function/const declaration or a re-export? `with[A-Z]` requires the
// lowercase-`with` factory spelling, so it won't match a `WithXOptions`
// type. Recursion is intentional: a service's factory may live in an
// `active.ts` or a nested helper (e.g. with-commit/history/ledger).
function exportsWithFactory(dir) {
  let found = false
  walkTsFiles(dir, (_file, content) => {
    if (found) return
    const code = stripComments(content)
    if (
      /export\s+(?:async\s+)?function\s+with[A-Z]\w*/.test(code) ||
      /export\s+const\s+with[A-Z]\w*\s*[:=]/.test(code) ||
      /export\s*(?:type\s*)?\{[^}]*\bwith[A-Z]\w*\b[^}]*\}/.test(code)
    ) {
      found = true
    }
  })
  return found
}

function requireServiceGate(id, dir) {
  if (SCHEMA_DECLARED_OR_INFRA_EXEMPT.has(id)) return
  if (exportsWithFactory(dir)) return
  fail(
    'strategy-opt-in',
    `service '${id}' exports no with*() factory. Every archetype-①/② service must ship a withX() opt-in gate (see the recipe in with-fork/snapshots). If it is genuinely a ③ schema feature or always-on infra, add it to SCHEMA_DECLARED_OR_INFRA_EXEMPT with a one-line reason.`,
    dir,
  )
}

function checkEveryServiceGated() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const dims = readdirSync(hubSrc, { withFileTypes: true })
    .filter(e => e.isDirectory() && (e.name.startsWith('with-') || e.name === 'via'))
  for (const dim of dims) {
    const dimPath = join(hubSrc, dim.name)
    const subFolders = readdirSync(dimPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist')
    if (subFolders.length === 0) {
      // The dim itself is the service (e.g. with-cargo, with-pod).
      requireServiceGate(dim.name, dimPath)
    } else {
      // A namespace dim — each leaf sub-folder is a service.
      for (const sub of subFolders) {
        requireServiceGate(`${dim.name}/${sub.name}`, join(dimPath, sub.name))
      }
    }
  }
}

// ─── Check 6: kernel-surface ceiling ───────────────────────────────────

// The always-on orchestration files (loaded by every `createNoydb`) must not
// grow back as services are added. Track A moved write-gating services
// (periods, guards) off these files onto the SubsystemBus; this ceiling locks
// that in. Each value is a RATCHET: lower it when a slice shrinks the file;
// raising it requires a conscious, reviewed bump. A service that re-couples
// itself into the kernel shows up here as a line-count regression — the fix is
// to register on the bus, not to grow these files.
const KERNEL_SURFACE_BUDGET = {
  // Bumped 3950→3985 for money() (#300), then →4010 for computed() (#302).
  // Both are Cluster-A write-pipeline hooks: quantize-on-put / decode-on-read
  // and computed-eval-on-put are inline transforms in the put/get hot paths,
  // the same kernel-resident placement as the i18nText/dictKey hooks — they
  // cannot move onto the SubsystemBus. The heavy logic lives in src/money/ and
  // src/computed/; only the thin call-sites are here.
  // Bumped 4010→4030 (2026-06-08): #322 read-path money parity — list()'s
  // no-locale decode + the `hasReadTransforms` gate are thin decode-on-read
  // call-sites in the get/list hot path (heavy logic in src/money/), same
  // kernel-resident class as the money()/computed() hooks above.
  // Bumped 4030→4040 (2026-06-12): #335 one-canonical-money-encoding —
  // canonicalizeIncomingMoney at the top of putInternal (gates/computed/
  // schema all see the get() shape) + canonicalizeStoredMoney at the gate
  // and derivation dispatch boundaries. Thin call-sites in the write hot
  // path; the canonicalization logic lives in src/money/normalize.ts.
  // Bumped 4040→4060 (2026-06-13): #344 sibling-source derivations —
  // dispatchDerivations re-reads the PRIMARY source record at the same id
  // when a write arrives via a declared sibling (spec.source !== this.name).
  // Thin branch in the write hot path; the registry/index logic lives in
  // src/derivations/.
  // Bumped 4060→4085 (2026-06-13): #291 staticDict — the read-path locale-gate
  // relaxation (hasStaticDisplay) + the per-field effLocale/displayLocale
  // branch in applyLocaleToRecord. This is the one read choke point the
  // hybrid resolution contract must extend; the resolver/registries live in
  // the tree-shaken withI18n() strategy + vault, not here.
  // Bumped 4085→4320 (2026-06-13): per-record CEK foundation (step 1 of the
  // erasure/sealing epic — #304/#306 gate). The CEK encrypt/decrypt branch is
  // a core write/read choke point: resolveRecordCek + isTombstone helpers, the
  // `_cek`-aware encryptJsonString/decryptJsonString/decryptRecord, the stable
  // CEK threaded through put/CRDT-put/delete-history/migration/dump and the two
  // conflict resolvers, plus the tier elevate/demote/getAtTier CEK re-wrap.
  // This is the per-record-key layer the kernel owns; forget()/shred (#304)
  // and record-scoped sealing (#306) build on top in their own services.
  // Bumped 4320→4440 (#304, forget cascade step 2): the tombstone read-path
  // hardening (RISK #1) touches every decrypt choke point — decryptJsonString
  // / decryptRecord now return null on a tombstone and ~15 callsites (get,
  // list/scan/listPage, history, CRDT reconcile + custom-merge, findByDet /
  // queryByDet, _invalidateCacheEntry, persisted-index rebuild/reconcile,
  // ensure/hydrate) skip null — plus the new `_writeTombstone` + `_decodeEnvelope`
  // shred primitives. These are core read/write-path edits the kernel owns; the
  // forget() orchestration + subject index live in vault.ts / src/forget/.
  // Bumped 4440→4460 (#306, record-scoped CEK sealing slices 2-3): the
  // `_invalidateCekCacheEntry(id)` core hook the kernel owns — `vault.rotateRecordCek`
  // must evict the per-record CEK cache synchronously with the live-envelope re-key
  // so no read returns the stale old-CEK record (the cekCache lives on Collection).
  // The seal/revoke/rotate orchestration + the host-side opener live in vault.ts /
  // src/sealed-record/.
  // Lowered 4460→4445 (2026-06-13): record-keys service extraction slice 1.
  // The pure tombstone predicate + envelope builder and the CEK-wrap surface
  // moved to src/record-keys/ (isTombstone now takes `encrypted` explicitly;
  // _writeTombstone calls buildTombstone).
  // Lowered 4445→4385 (2026-06-13): record-keys extraction slice 2. The CEK
  // write-path lifecycle moved to src/record-keys/lifecycle.ts behind a deps
  // interface — resolveRecordCek is now a thin delegate to resolveStableCek,
  // and the elevate/demote tier re-wrap if/else collapsed into rewrapBodyToDek.
  // Bumped 4385→4610 (2026-06-14, 0.2.0-pre.18): #376 FK-keyed derivations —
  // triggerBy reverse-denormalization + withRollup aggregate-onto-parent. The
  // dispatch refactor (runs[] fan-out), self-write denorm with value-equality
  // cycle guard, _getStoredRecord/_findMatchingIds index lookup, and the rollup
  // recompute + onDelete hook are write-path orchestration that must sequence
  // with the existing derivation dispatch; the rollup/trigger registries live
  // in src/derivations/.
  // Bumped 4610→4640 (2026-06-14, #401): `_purgePersistedIndexes(id)` — the
  // erasure-path teardown of a record's `_idx` side-cars that `forget()` calls
  // (they live under the retained collection DEK, so crypto-shred alone leaves
  // them readable). Must be on the collection (owns the adapter + index defs).
  // Bumped 4640→4665 (2026-06-14, #308): the thin `collection.search()`
  // scan-mode entry point (eager-cache iterate + delegate). The tokenizer +
  // BM25 ranker engine live in the tree-shakeable src/search/ service.
  // Bumped 4665→4675 (2026-06-15, #285 §3): the join-layer i18n seam —
  // querySourceForJoin exposes the right collection's i18nFields, and query()/
  // scan() thread the default locale into the JoinContext. The resolution
  // itself lives in src/query/join.ts.
  // Bumped 4675→4720 (2026-06-15, #413): debug-plaintext record layout — the
  // buildDebugEnvelope inliner plus the encryptRecord/decryptJsonString
  // branches that emit and reconstruct the directly-inspectable envelope.
  // This is intrinsic to the core record write/read path, so it lives here.
  // Bumped 4720→4730 (2026-06-15, #412 P3): objectStore + blobFields threaded
  // into the blob openSlot args so external blob fields route raw bytes to an
  // ObjectProjection. Core blob-access wiring, lives on the hot path here.
  // Bumped 4730→4800 (2026-06-17, FR-5 #445): provenance opt-in + _source/_sourceTs
  // injection at encryptJsonString / buildDebugEnvelope / putAtTier envelope sites.
  // Bumped 4800→4810 (2026-06-17, FR-4): sourceTs? origin-override param threaded
  // through put / putInternal / encryptRecord / encryptJsonString / buildDebugEnvelope /
  // putAtTier — additive, guarded (provenance&&source!==undefined), zero cost off.
  // The 4 extra lines are param additions + one JSDoc sentence (no logic growth).
  // Bumped 4810→4830 (2026-06-17, FR-8 Task 1): public validateInput() wrapper —
  // thin 14-line method + JSDoc delegating to validateSchemaInput without writing;
  // used by migrateThenMerge staging safety pre-check.
  // Bumped 4830→4911 (2026-06-20, #435 Task 7): densifyOnWrite wiring — i18nDensifyFields
  // field + constructor subset, prior-read + computeExemptFills before enforceScript,
  // densify() call after the put-validator, plus resolveDensifyPrior + i18nProvenance
  // accessor. Densify logic lives in src/i18n/densify.ts; only thin call-sites are here.
  // Bumped 4911→4922 (2026-06-20, #435 review): stripI18nFilled at the three
  // locale-less read returns (get/list early-return, search, static-display final).
  // Bumped 4922→5100 (#308 L1): retrieve()/warmIndex call-sites + dict/blob label resolvers (engine in src/search/)
  // Bumped 5100→5168 (#308 L1.5): persisted-index call-sites + forget/close wiring
  // Bumped 5168→5255 (#308 L2): embeddings derive/retrieve/forget call-sites (engine in src/embeddings/)
  // Bumped 5255→5278 (#308 L3): retrieveLexical/retrieveHybrid private methods + thin retrieve() dispatcher
  // Bumped 5278→5285 (#308 L3 Task 4): applyWithin() private method + within dispatch in retrieve()
  // Bumped 5285→5293 (#483 Task 1): fieldMeta private field + getFieldMeta() getter + FieldMeta type import
  // Bumped 5293→5332 (#483 Task 3): describe() sync method + _refs private field + buildDescription import + declaredRefs opt
  // Bumped 5332→5374 (#483 Task 4): describeAsync() private method (derive zodFields + resolveDictLabels + delegate to buildDescription)
  // Bumped 5374→5379 (#483 fix-wave): _applyFieldMeta() — first-wins reconciler mirroring _applyMoneyFields, needed for MV-pre-created collection re-declaration path
  // Bumped 5379→5399 (#483 Task 1): CollectionMeta import + private meta field + getMeta() getter + _applyMeta() reconciler + meta threading into both describe() calls
  // Bumped 5399→5401 (#483 Task 3): i18nFields passed into both buildDescription call-sites
  // Bumped 5401→5457 (#483 Task 4): CollectionConfig import + getConfig() aggregator (reads existing private fields, no new state)
  // Bumped 5457→5473 (#483 review follow-up): historyConfigExplicit private field + opts flag for presence-semantic history in getConfig()
  // Bumped 5473→5486 (#484 Task 2): toJSONSchema() thin delegator + buildJsonSchema/derivePersistedSchema imports (logic lives in json-schema.ts)
  // Bumped 5486→5496 (storage-arch P2 foundation): ramCiphertext opt-in flag — field + opts + doc-comment + test getter. The documented hook for the future ciphertext-resident-working-set phase (default false, no behavior change). P2-T3 (StoreEdgeCodec extraction) moves crypto logic OUT of this file.
  // Bumped 5496→5566 (#503 structural group-encryption): sensitive-field sealing is genuine crypto core — the write path peels declared `sensitive` fields out of `_data` and seals each into `_sealed[field]` under a per-field key, the read path re-merges them, plus the `sensitiveFields` set + `sensitive` opt + doc-comments. The per-field key derivation lives in crypto.ts (`deriveSealedFieldKey`); only the per-record encrypt/decrypt orchestration is here, beside the existing `_det`/`_cek` seams it mirrors.
  // Bumped 5566→5593 (P3 safety fixes): three constructor guards — forget-cascade/perRecordCek incompatibility warn, debug-plaintext no-op warn, doc-comment note on #306. All are defensive one-time console.warn calls; no behavior change to default-off paths.
  // Bumped 5593→5680 (P3 Sealed<V> access gate): the sealed-field handle layer is genuine crypto/cache core. Adds `unsealField` (shared by inline-decrypt + handle reveal()), `makeSealedHandle`/`toCacheRecord` (build non-leaking handles for the working-set cache so sealed plaintext is never resident), `resolvePriorValues` (eager write/delete paths re-decrypt real values rather than re-encrypt cache handles), and `sealedAsHandles` routing through decryptRecord + the cache/public read paths. Sits directly on the existing `_sealed` seam; the per-field key derivation still lives in crypto.ts.
  // Bumped 5680→5721 (P3 lazy-mode Sealed-field corruption/leak fix): mirrors the eager `resolvePriorValues` for the lazy `_getStoredRecord` patch base — on a sealed collection it re-decrypts the stored envelope to REAL values (never re-encrypting a cache handle into the marker `'[sealed]'`) and populates the LRU in handle form via `toCacheRecord` (never sealed plaintext). Plus a one-time constructor `console.warn` when a `sensitive` field also appears in `indexes` (plaintext index defeats non-residency). Both are core crypto/cache correctness on the existing `_sealed`/LRU seams.
  // Bumped 5721→5740 (#306 Slice B record-scoped sealing): sealed-field keys now derive off the per-record CEK so `forget()` crypto-shreds them. Adds the shared `resolveEnvelopeCek` helper (one unwrap+cache path for both body and sealed decryption), the dual-read fallback in `unsealField` (CEK-derived key first, collection-DEK key on auth failure — the data-loss guard for pre-#306 records), and threads the CEK through `makeSealedHandle`/`decryptRecord`/`toCacheRecord`. Net of removing the now-obsolete forget-cascade `console.warn`. Core crypto on the existing `_sealed`/`_cek` seams.
  // Bumped 5740→5774 (#M-1 forget erasure fix, 2026-06-30 security review): `_classifySealedShred(live)` classifies each live `_sealed` slot as CEK-derived (genuinely crypto-shredded when `_cek` drops) vs pre-#306 collection-DEK-derived (residue — DEK retained, synced copies stay decryptable). Reuses `resolveEnvelopeCek` + the `unsealField` iv:data split + `deriveSealedFieldKeyFromCek`; keeps the classification crypto in collection.ts so vault.ts's forget() loop stays a thin caller.
  // Lowered 5774→5433 (RecordCodec extraction, Phase 1): the per-record envelope build + encrypt/decrypt + per-record-CEK + sealed-field crypto (encryptRecord/encryptJsonString/buildDebugEnvelope/decryptRecord/decryptJsonString/resolveEnvelopeCek/unsealField/makeSealedHandle/toCacheRecord + the classify body) moved to `record-keys/record-codec.ts`; Collection holds a `RecordCodec` instance and delegates. `_classifySealedShred` stays as a 1-line shim (vault.ts forget() reaches it). The `iv:data` dual-read is now the shared `record-keys/sealed-slot.ts`.
  // Lowered 5433→5401 (Phase 5 A1: deterministic-index extraction): `findByDet`/`queryByDet` moved to `record-keys/deterministic.ts` behind a `DeterministicContext`; Collection keeps thin delegators + a `detContext()` binder.
  // Lowered 5401→5185 (Phase 5 A13: tiers extraction): `putAtTier`/`getAtTier`/`listAtTier`/`elevate`/`demote`/`assertTiersEnabled`/`assertDeclaredTier`/`isElevatorOrOwner`/`_classifySealedShred` moved to `with-audit/tiers/index.ts` behind a `TiersContext`; Collection keeps thin delegators + a `tiersContext()` binder. `cekCache` passed by reference; `emitCrossTierEvent` stays collection-resident (captures `onCrossTierAccess`), reached via callback.
  // Lowered 5185→4962 (Phase 5 A14: search/retrieval extraction): `search`/`flushIndex`/`warmIndex`/`retrieve`/`similarTo` + the build/resolve/retrieveLexical/Semantic/Hybrid helpers moved to `with-lookup/search/collection-facade.ts` behind a `SearchContext`; Collection keeps thin public delegators + a `searchContext()` binder. The eager `cache` Map is passed by reference; `buildPersistedIndexCallbacks` takes a context THUNK (ctor-invoked before `codec` exists, resolved lazily per callback).
  // Lowered 4962→4686 (Phase 5 A15: index-maintenance extraction): `rebuildEagerIndexesFromCache`/`rebuildUniqueConstraintsFromCache`/`rebuildIndexes`/`reconcileIndex`/`maintainPersistedIndexesOnPut`/`OnDelete`/`_purgePersistedIndexes` + the readPersistedValue/serializeIndexValue/extractIndexValue/valuesMatch helpers moved to `with-lookup/indexing/collection-facade.ts` behind an `IndexingContext`; Collection keeps thin delegators + an `indexingContext()` binder. The eager `cache` Map + the index/unique/persisted mirrors are passed by reference; `persistedIndexesLoaded` flag + `ensure*` hydration stay collection-resident, reached via callbacks. putInternal/the write path is untouched (still calls the same delegator names).
  // Lowered 4686→4301 (Phase 5 A11: constructor → resolveCollectionConfig): the inline opts type literal + the pure opts-resolution half (every `?? default`, the derived `Set`/`VectorSet`/CEK-`Lru`, the embeddings-on-CRDT / money-path / deterministic-risk validations) moved to `collection-config.ts`; the constructor becomes thin wiring (resolve → assign → searchIndexStore/codec/conflict-resolver registration → lazy/index cluster). searchIndexStore + the conflict-resolver registration + the lazy/index cluster stay constructor-resident: searchIndexStore for the persisted-index thunk ordering (built before codec), the conflict resolvers because their closures capture private `this` state AND `conflictPolicy: ConflictPolicy<T>` (invariant in T — a method param would break `Collection<T>`→`Collection<unknown>`), and the lazy/index cluster to preserve the registration→validation side-effect order.
  // Bumped 4301→4310 — 2026-07-04 classified-fields stage 1 Task 3 (threading): private
  // `classified` field + ctor assignment + `_applyClassifiedFields` reconcile method + collision guard.
  // Bumped 4310→4320 — 2026-07-04 classified-fields stage 1 Task 4 (write-enforcement):
  // enforceClassifiedWrite call in _putInternal before computed stage (thin call-site + pure validation).
  // Bumped 4320→4346 — 2026-07-04 classified-fields stage 1 Task 6 (reveal gate): private
  // `classifiedStrategy` field + ctor assignment + the public `reveal()` delegator method.
  // Bumped 4346→4357 — 2026-07-04 classified-fields final review — reconcile sealing guard:
  // `_applyClassifiedFields` refuses recoverable classified fields declared after first open
  // (fail-loud instead of silently leaving them unsealed).
  // 2026-07-04 classified stage-2 T7 — bumped 4357→4358: one-line `vdigFields: null`
  // placeholder in the RecordCodec constructor call (Task 8 replaces it with the real map).
  // Bumped 4358→4394 (2026-07-04 classified stage-2 T8): prev-envelope threading for
  // digest-only `_vdig` carry-forward (C6) — thin { id, prev } plumbing at the
  // encryptRecord call sites; the digest/carry crypto lives in kernel/enclave/classify/.
  // Bumped 4394→4436 (2026-07-04, classified stage 2 T13): both-door Refusal-matrix
  // guard call-sites (R1-R6) — the stored `classifiedGuardCtx` + the door-2 guard,
  // the R6 session form-flip refusal, and the digest-only retro-attach refusal in
  // `_applyClassifiedFields`; the guard logic lives in with-shape/classified/guards.ts.
  // Bumped 4436→4478 (2026-07-04, classified stage 2 T15): verify()/verifyGroup()
  // public oracle doors — thin ctx builders; the oracle lives in kernel/enclave/classify/verify.ts.
  // Bumped 4478→4481 (2026-07-04, classified stage 2 T16): reveal() ctx widened from a
  // single getView() to the raw-envelope shape (getEnvelope/resolveCek/getDEK) — the
  // reveal engine itself moved into kernel/enclave/classify/reveal.ts (I6).
  // Bumped 4481→4506 (2026-07-04, classified slice 2b T6): C-A/R10 config-drift guard —
  // per-handle memoization state + the first-write marker-persist hook + the naive-handle
  // codec signal. Irreducible kernel write-path wiring; the marker store I/O itself lives in
  // with-shape/classified/config-drift.ts and the R10 throw in enclave/record-keys/record-codec.ts.
  // Bumped 4506→4507 (2026-07-04, classified slice 2b T8): the per-slot
  // `SealedShredSlot` type import for `_classifySealedShred`'s return annotation.
  // Bumped 4507→4592 (2026-07-05, classified slice 2b T13): the `findByDigest`
  // equatable blind-index lookup — the security-critical scan+confirm orchestration
  // (R9 single-message refusal, target-before-scan I-1 ordering, the list+N-get scan
  // retaining hit envelopes, the single 'find' sweep consent op, and the in-hand
  // confirm-by-verify ctx). The enclave target/verify crypto stays behind the
  // strategy seam (`computeTarget`) + a dynamic `import()` of verifyDigestField; only
  // the store-shape-invariant scan/confirm wiring is here, beside the sibling
  // findByDet scan it mirrors.
  // Bumped 4592→4654 (2026-07-05, classified slice 2b T14): the
  // `scrubEquatableTags` maintenance sweep — the sole lazy-write-independent
  // `_bidx` drop-path (envelope rewrite dropping the field's tag) plus its
  // ledger-consistency append (op:'migration', no `_v` bump, new payloadHash)
  // so the scrub keeps the hash chain verifiable.
  // Lowered 4481→4476 (2026-07-04, #267 lazy service): the lazy-mode budget
  // validation + LRU construction moved out of the constructor onto the
  // lazy strategy seam (port/with/lazy-strategy.ts; withLazy() /
  // IMPLICIT_LAZY back-compat default).
  // Merge 2026-07-05 (#582 ∪ #267/#580): reconciled to the TRUE post-merge line
  // count — collection.ts now carries #267's lazy-strategy extraction AND this
  // branch's findByDigest/scrubEquatableTags together. Not loosened past the real count.
  // Bumped 4647→4662 (2026-07-07, #591 satellites archetype-③ — thin call-sites only
  // (declare/joined accessor/proxy wrap/forget ref-expansion/pair-sync hooks); heavy
  // logic in with-shape/satellites): documented actual post-implementation line count.
  // Bumped 4662→4664 (2026-07-09, +2: #590 forget→sync-dirty-log hook): _writeTombstone
  // enters the sync dirty log via the existing onDirty seam so the shred propagates on
  // push; one comment + one call, the sync engine itself stays in with-party/team/sync.ts.
  // Bumped 4664→4678 (2026-07-09, +14: #589 _doDelete writes a delete marker under
  // sync via buildDeleteMarker; converges deletes on pull. Marker helpers live in enclave.
  // Bumped 4678→4693 (2026-07-09, +15: #589 re-create version continuity): a put
  // re-creating a deleted id continues from the marker's `_v + 1` instead of resetting
  // to 1, gated on `!existing && onDirty` and reusing the lazy branch's raw read so
  // there is exactly one `adapter.get` on the re-create path.
  // Bumped 4693→4705 (2026-07-09, +12: #589 final-review Fix 2): `_doDelete` now
  // captures the marker's minted version (`markerVersion = live._v + 1`) and reports
  // that same version to `onDirty`, instead of the separately-derived `existing?.version`
  // which could disagree with it (lazy mode, uncached record, history disabled) and
  // desync the dirty entry's version from the marker actually written. Also dedupes
  // the `previousEnvelope`/`live` reads into one `adapter.get`.
  // Lowered 4705→4473 (2026-07-11, Task 11 re-ratchet, #623 via-port arc):
  // net −232 from the 4705 peak. The arc moved money/i18n's write/read
  // cutover onto the ViaPipeline (7c885b87, 5e44df6b, 598e8ac6), relocated
  // with-shape/money → via/money and with-shape/i18n → via/i18n
  // (9361663c, 43765b56), and extracted generic path utils to kernel/paths
  // (57851399) — so the inline quantize/decode/locale logic this file used
  // to carry left the kernel spine for the shape/via-* feature layer. Locked
  // in to the ACTUAL measured line count (readFileSync(...).split('\n').length)
  // — no slack.
  // Lowered 4473→4472 (2026-07-13, via-consolidation Task 6 final re-ratchet,
  // #642/#651/#640/#654): the arc's Task 5 fix wave landed the file 1 line
  // UNDER ceiling (the #640 rollup-on-delete work funded its own growth via
  // shrink-first folds) and no later task in the arc touched this file —
  // ratcheting the ceiling down to the actual per the checker's own
  // ratchet-to-actual convention, so the margin isn't silently carried
  // forward as slack for an unrelated future change.
  // Bumped 4472→4503 (2026-07-15, #606: per-collection marker-id set to skip
  // the redundant adapter.get on synced-eager insert): a `Set<string>` field
  // + population at hydration (both paths)/local-delete/the sync-tab-cutover
  // choke point, plus the gated read at the #589 continuity check and the
  // clear on re-create success.
  // Bumped 4503→4521 (2026-07-15, #606 adversarial-review fix): moved the
  // marker-id maintenance in `_invalidateCacheEntry` above the `!hydrated`
  // gate (a marker landing mid-hydration was never recorded, permanently
  // for the session) and added a synchronous pre-switch maintenance step in
  // `_onRecordMutated` to close the await-window race against a concurrent
  // put. Comments explaining both fixes account for the growth.
  // Bumped 4521→4529 (2026-07-15, #693: tab-coordination fallback for the marker-set gate):
  // `tabCoordinated` private field + constructor assignment + the gate's fallback
  // condition/comment at the #589/#606 re-create check.
  'packages/hub/src/kernel/collection.ts': 4529,
  // Bumped 3640→3700 (2026-06-08): deferred-numbering wiring — `sequence()`
  // routing + `runNumberingPass` + the cache-coherent `stamp` closure. The
  // engine itself lives in src/numbering/; only the thin vault call-sites are here.
  // Bumped 3700→3735 (2026-06-13): #345 sequence partition/seedTo routing in
  // `sequence()` (engine in src/sequence/) + #346 cascade-delete atomicity —
  // child deletes register on the active TxContext inside enforceRefsOnDelete.
  // Bumped 3735→3905 (2026-06-13): #291 staticDict — the static-name registries
  // (staticDictNames / staticByName / staticDescriptorByField), the read-path
  // resolver branch, enforceStaticDictOnPut (UnknownDictCodeError), the
  // StaticDictReadonlyError guard in dictionary(), the static branch in
  // applyLocale + resolveDictSource, and the resolveLabelFromMap helper. These
  // are the config-time registry + the two label-resolution seams the hybrid
  // contract requires to live on the vault; no per-vault _dict_* storage added.
  // Bumped 3905→3925 (2026-06-13): per-record CEK foundation — the
  // `perRecordKeys` collection option (doc + threading into collOpts),
  // mirroring the deterministicFields wiring. Config-time only; the CEK
  // crypto lives in collection.ts / crypto.ts.
  // Bumped 3925→4100 (#304, forget cascade step 2): `vault.forget()` is a
  // genuinely-core write-path orchestrator — it must drive `_writeTombstone` +
  // `tombstoneHistory` per record, detect un-migrated / blob residue, and
  // append the single `op:'forget'` ledger entry inline with the keyring/DEK.
  // Adds forget() + rebuildSubjectIndex() + the _addSubjectRef/_removeSubjectRef
  // hooks + the perRecordKeys-forcing in collection(); the subject-index crypto
  // and the strategy declaration live in src/forget/ (the @noy-db/hub/forget subpath).
  // Bumped 4100→4280 (#306, record-scoped CEK sealing slices 2-3): the grantor
  // side is genuinely core — it needs the collection DEK to `sealRecordToHost`
  // (unwrap `_cek`, seal a `{collection,id,cek,expiresAt}` binding to a host
  // RecipientSealer, write the `_sealed_cek/<collection>/<id>/<pid>` delivery
  // envelope), `revokeSealedRecord`, and `rotateRecordCek` (hard re-key + dual
  // cache eviction + prefix-delete of all sealed envelopes). The wire/binding
  // types + the host-side `openSealedRecord` (which holds no DEK) live in
  // src/sealed-record/ (the @noy-db/hub/sealed-record subpath).
  // Lowered 4280→4195 (2026-06-13): record-keys extraction slice 2. The grantor
  // sealing orchestration (sealRecordToHost / revokeSealedRecord /
  // rotateRecordCek) moved to src/record-keys/sealing.ts behind a SealingContext
  // deps interface; vault retains thin delegating methods + a sealingContext()
  // builder. The host-side opener stays DEK-free in src/sealed-record/.
  // Bumped 4195→4210 (2026-06-13): #365 slice 2 — forget() now crypto-shreds a
  // shredded record's erasable blobs inline (BlobSet.shredAllForRecord per ref)
  // and reports blobsShredded / blobsRetainedShared. This is core erasure
  // orchestration — it must sequence with the per-record tombstone + the single
  // op:'forget' ledger entry, so it cannot move onto the bus. The blob refCount/
  // crypto-shred mechanics live in src/blobs/blob-set.ts.
  // Bumped 4210→4470 (2026-06-14, 0.2.0-pre.18): the pilot-2 fast-lane batch —
  // #375 formatted/reset-aware sequence() overload, #377-A refArray enforcement
  // branches in enforceRefsOnPut/Delete/checkIntegrity, #377-B vault.link/links
  // managed M:N (link-set methods + enforceLinksOnDelete + reserved guard), and
  // #361 per-collection history-ledger scoping (historyConfig on collection()).
  // These are call-site/enforcement seams that must live on the always-on vault;
  // the engines live in src/sequence/, src/refs.ts, and src/links/.
  // Bumped 4470→4485 (2026-06-14, #401): forget() now purges each shredded
  // record's persisted `_idx` side-cars + reports residue (indexPostingsPurged /
  // indexResidue) — core erasure orchestration alongside the tombstone/blob shred.
  // Bumped 4485→4495 (2026-06-15, #285 export layer): exportStream reads each
  // record at the export locale through the `export` layer (i18nText collapse +
  // dict-label resolution) + skips the now-redundant dictionary snapshot.
  // Bumped 4495→4505 (2026-06-15, #412 P3): objectStore field + constructor
  // opt + thread into every Collection (mirrors blobStrategy).
  // Bumped 4505→4510 (2026-06-16, #199 P3): four thin UserApi closures wiring
  // the two-party withdrawal ceremony to the bundle service (logic lives in
  // bundle/request-withdrawal.ts; vault.ts only injects the closures).
  // Bumped 4510→4520 (2026-06-17, FR-5 #445): provenance option + collOpts thread.
  // Bumped 4520→4545 (2026-06-17, FR-6 Task 6): custody surface field + wiring
  // (`public readonly custody: CustodyApi` + the three-closure injection
  // mirroring the UserApi pattern; logic lives in custody/index.ts + liberate.ts).
  // Bumped 4545→4546 (2026-06-20, #469): coordination-port wiring threads the
  // injected `CoordinationProvider` into SchemaFenceController + FenceWatcher
  // (the barrier/transport logic itself lives in coordination/ + schema-update/).
  // Bumped 4546→4571 (#308 L1): getDictionary label-resolver injection + warmIndexOnOpen wiring (engine in src/search/)
  // Bumped 4571→4597 (#308 L1.5): persisted-index call-sites + forget/close wiring
  // Bumped 4597→4610 (#308 L2): embeddings derive/retrieve/forget call-sites (engine in src/embeddings/)
  // Bumped 4610→4617 (#483 Task 1): fieldMeta option in CollectionOptions + FieldMeta import + validation call-site
  // Bumped 4617→4621 (#483 Task 3): declaredRefs wiring (snapshot of outbound refs for describe())
  // Bumped 4621→4633 (#483 Task 1): meta option in CollectionOptions + _applyMeta reconcile in cached-collection branch + meta threading into new Collection() opts
  // Bumped 4633→4650 (#483 Task 2): vaultMeta field + getMeta() getter + constructor opts + _introspectState() wiring
  // Bumped 4650→4659 (#483 review follow-up): historyConfigExplicit threading + archive/schemaUpdate accessors in _introspectState()
  // Bumped 4659→4665 (storage-arch P2 foundation): plumb ramCiphertext through vault.collection() to collOpts (TS declaration + pass-through) so the opt-in flag is reachable/testable. Minimal necessary plumbing.
  // Bumped 4665→4674 (#503 structural group-encryption): plumb the `sensitive` collection option through vault.collection() to collOpts (TS declaration + doc-comment + pass-through), mirroring deterministicFields. Minimal necessary plumbing; the sealing crypto lives in collection.ts/crypto.ts.
  // Bumped 4674→4677 (#306 Slice B record-scoped sealing): forget() counts and reports `sealedFieldsShredded` (read each shredded record's live `_sealed` slot count before tombstoning) on the existing forget orchestration. +3 lines; the sealing crypto lives in collection.ts/crypto.ts.
  // Bumped 4677→4723 (#H-1/#M-1 forget erasure fixes, 2026-06-30 security review): forget() now (H-1) prefix-deletes the record's `_sealed_cek` host-delivery envelopes — mirroring rotateRecordCek, so a granted at-* host can't recover an "erased" record from a synced body + surviving sealed CEK — and (M-1) classifies `_sealed` slots via the collection helper, counting only CEK-derived slots as shredded and reporting legacy DEK-derived slots as residue, with a defensive try/catch so a corrupt `_cek` reports residue instead of aborting erasure mid-loop. +3 result/ledger fields + 3 counters. The classification crypto lives in collection.ts (`_classifySealedShred`); vault.ts holds only the forget-loop orchestration.
  // Lowered 4723→4627 (Phase 5 A6: ElevatedHandle extraction): the inner `ElevatedHandle` class + `ELEVATION_AUDIT_COLLECTION` const moved to `with-commit/tx/elevated-handle.ts`; vault.ts imports them (elevate() / _elevatedPut) and index.ts re-exports from the new module.
  // Lowered 4627→4587 (Phase 5 A2: attestation extraction): the issue/revoke methods + `make*Context` closures + the field-schema registry moved to `with-audit/attestation/vault-facade.ts` (`VaultAttestation`); vault.ts holds a facade instance + thin delegators.
  // Lowered 4587→4547 (Phase 5 A7: capability gating extraction): `assertCanExport`/`assertCanImport`/`canExport`/`canImport` predicate bodies moved to `capabilities.ts` (pure keyring predicates); vault.ts keeps the typed public overloads + thin delegators.
  // Bumped 4547→4559 (bundle includes blobs): dump() now enumerates the blob collections (global _blob_index/_blob_chunks/_blob_eviction_audit + per-collection _blob_slots_*/_blob_versions_*) so blob "covers" travel in the .noydb bundle; +12 lines (inlined name literals + computed internalNames array + explanatory comment), no blob runtime pulled into the hot path.
  // Lowered 4559→4410 (Phase 5 A3: periods extraction): the close/open/list/get methods + `_assertTsWritable` guard + `_loadPeriodsCache`/`_writePeriodRecord`/`_decryptPeriodRecord` helpers + the `periodCache` field moved to `with-audit/periods/vault-facade.ts` (`VaultPeriods`); vault.ts holds a facade instance + thin delegators (`_assertTsWritable` still the gate-bus entry point).
  // Lowered 4410→4135 (Phase 5 A4: backup extraction): `dump`/`load`/`verifyBackupIntegrity`/`exportJSON` (incl. the blob-collection enumeration in dump() and the branchy chain+data-envelope integrity walk) moved to `vault-backup.ts`; vault.ts holds thin delegators + a `backupContext()` builder exposing the read paths and the post-load mutation seams (reloadKeyring/cache-clear/ledger-reset).
  // Lowered 4135→3824 (Phase 5 A5: refs/links enforcement extraction): `enforceRefsOnPut`/`enforceRefsOnDelete`/`enforceLinksOnDelete`/`resolveRef`/`resolveSource`/`checkIntegrity` bodies + the `cascadeInProgress` cycle-breaker set moved to `with-shape/links/vault-facade.ts` (`VaultLinks`); vault.ts holds a facade instance + thin delegators (the `refEnforcer`/`joinResolver` ctor seam is unchanged — Collection still passes `this`). The ref/link registries stay vault-resident (populated by collection()/link(), read by the backup path) and arrive by reference.
  // Bumped 3824→3825 then 3825→3826 (S4 Task 1: gate attestation behind withAttestation()):
  // vault.ts threads the opt-in `attestationStrategy` — a single option-type field on the
  // Vault ctor + a `?? NO_ATTESTATION` fallback into the always-built VaultAttestation facade
  // (imported off the existing vault-facade re-export, so no new import line). The issue/revoke/
  // signer engines stay in the lazy `with-audit/attestation/active.ts` chunk; only the strategy
  // seam is here.
  // Bumped 3827→3832 (S4 Task 2: gate tiers behind withTiers()): vault.ts threads the opt-in
  // `tiersStrategy` into every Collection it builds — a type-only import + a ctor option-type field
  // + a field + a `this.tiersStrategy = opts.tiersStrategy` assignment + the one collection()-opts
  // spread line (mirrors the crdtStrategy seam). The tier read/write/re-key engine stays in the
  // lazy `with-audit/tiers/active.ts` chunk; only the strategy pass-through is here.
  // Bumped 3832→3833 (S4 Task 3: gate sealed-record behind withSealedRecord()): vault.ts gains a
  // `sealedRecordStrategy` field + ctor option-type field + a `?? NO_SEALED_RECORD` assignment; the
  // three grantor methods route through it (existing lines) and the now-orphaned record-keys impl
  // imports were dropped (import block shrank 7→4 lines), so the net is +1. The grantor engine is
  // reached only via the lazy `with-audit/sealed-record/active.ts` chunk.
  // Bumped 3833→3834 (S4 Task 4: gate portability behind withPortability()): vault.ts gains a
  // `portabilityStrategy` field + ctor option-type field + a `?? NO_PORTABILITY` assignment; the six
  // `UserApi` closures route through it (existing lines) and the three direct portability fn imports
  // were replaced by one strategy import (import block shrank 3→1), so the net is +1. The
  // export/withdraw/request engines are reached only via the lazy `with-audit/portability/active.ts` chunk.
  // Bumped 3834→3840 (S4 Task 8: gate sequence behind withSequence()): vault.ts gains a
  // `sequenceStrategy` field + ctor option-type field + a `?? NO_SEQUENCE` assignment + one import
  // line + a 2-line opt-in comment where `vault.sequence()` builds its store through the strategy
  // (`new SequenceStore(...)` → `this.sequenceStrategy.createStore(...)`). The CAS SequenceStore
  // engine is reached only via the opt-in `with-commit/sequence/active.ts` chunk.
  // Bumped 3840→3841 (S4 Task 5: gate custody behind withCustody()): net +1 — the static
  // `liberateVault` import was dropped (-1, now reached only via the lazy
  // `with-party/custody/active.ts` chunk) and the custody-closure comment expanded (+2) where
  // `vault.custody.liberate` now routes through `this.noydb.custodyStrategy.liberate(this, ...)`.
  // Bumped 3841→3846 (S4 Task 7: gate search behind withSearch()): vault.ts gains a
  // `searchStrategy` field + ctor option-type field + a plain assignment + one import line + one
  // pass-into-collection spread (+5). The search/retrieval engine + the embedding write-hook are
  // reached only via the lazy `with-lookup/search/active.ts` chunk (dynamic import of the facade).
  // Bumped 3846→3855 (S4 Task 9: gate cargo behind withCargo()): the `extractPartition` /
  // `diffVault` free functions take a `Vault`, so the Vault carries a PUBLIC `cargoStrategy` field
  // they route through — a `?? NO_CARGO` assignment + ctor option-type field + one import + the
  // field's doc comment (+9). The extraction crypto + diff walk are reached only via the lazy
  // `with-cargo/active.ts` chunk (which dynamically imports `extractPartitionCore`/`diffVaultCore`;
  // the crypto body is unchanged).
  // Bumped 3855→3857 — 2026-07-04 classified-fields stage 1 Task 3 (threading): public
  // `classifiedFields` option + reconcile branch + fresh-construction thread-through.
  // Bumped 3857→3862 — 2026-07-04 classified-fields stage 1 Task 6 (reveal gate): private
  // `classifiedStrategy` field + ctor option + ctor assignment + collOpts thread-through.
  // Bumped 3862→3866 (2026-07-04, classified stage 2 T13): plumb `subjectKeyField` from
  // `forgetStrategy.subjects[collectionName]` into collOpts so the Refusal-matrix R4 row
  // (digest-only cannot be the forget-subject key) sees it; guard logic lives in
  // with-shape/classified/guards.ts.
  // Bumped 3866→3877 (2026-07-04, classified slice 2b T8): forget() crypto-shred
  // accounting rewritten against `classifySealedShred`'s per-slot shape — the
  // `_bidx` third category ('live-shreddable+dekResidue-in-backups') counts as
  // BOTH shredded and dekResidue-in-backups (honest dual accounting).
  // Bumped 3877→3883 (2026-07-05, classified slice 2b T10): the equatable
  // double door — CollectionOptions gains `acknowledgeEquatableRisk` (+JSDoc)
  // and vault.collection() threads it into collOpts (mirrors
  // acknowledgeDeterministicRisk). Genuinely core: the R8 gate is a
  // construction-time collection option.
  // Bumped 3866→3871 (2026-07-04, #267 lazy service): standard strategy
  // plumbing only — the lazyStrategy opts field, private field, assignment,
  // collection() pass-through and type import. No logic; offset by the
  // collection.ts −5 above (net kernel-spine LOC for #267 items 1+2 is ±0
  // while the grant/revoke/rotate keyring engines left the floor).
  // Merge 2026-07-05 (#582 ∪ #267/#580): reconciled to the TRUE post-merge line
  // count — vault.ts now carries #267's lazyStrategy plumbing AND this branch's
  // acknowledgeEquatableRisk door together. Not loosened past the real count.
  // Bumped 3888 → 3898 (2026-07-05): the secret-bearing reserved-collection
  // guard at the collection() door — a genuinely-core trust-boundary check
  // (closes a granted-principal read path to `_sync_credentials`) that sits
  // alongside the existing _dict_/_links_ reserved-name guards.
  // Bumped 3898→3949 (2026-07-07, #591 satellites archetype-③ — thin call-sites only
  // (declare/joined accessor/proxy wrap/forget ref-expansion/pair-sync hooks); heavy
  // logic in with-shape/satellites): documented actual post-implementation line count.
  // Bumped 3949→3956 (2026-07-07, #591 final-review I2/R-S8 fix): two new
  // `SatelliteDeclareContext` ctx-accessor lines (`getBaseCrdt`/`collectionExists`,
  // thin call-sites only) + a 4-line R-S8-direction-(ii) guard near the top of
  // `collection()` (refuses constructing — fresh OR already-cached — a satellite
  // pair member with crdt AFTER the pair already exists; must run before the
  // `if (!coll)` construction branch, since re-declaring an ALREADY-cached
  // collection with a new option skips that branch entirely) — still a thin
  // call-site; the R-S8 refusal logic itself lives in with-shape/satellites/validate.ts.
  // Bumped 3956→3964 (2026-07-09): #598 sync cache-invalidation wiring
  // (vault._invalidateSyncApplied + openVault hook) — the @internal
  // `_invalidateSyncApplied(collection, id)` helper the kernel owns: peeks
  // collectionCache and delegates to the existing Collection
  // `_invalidateCekCacheEntry`/`_invalidateCacheEntry` pair so sync-applied
  // envelopes (pull applies, conflict winners, tombstone enforcement) evict
  // stale decrypted views. Thin call-site; the sync engine lives in with-party/team/.
  // Bumped 3964→3990 (2026-07-09): #589 _purgeDeleteMarkers seam — the @internal
  // `_purgeDeleteMarkers(before, collections?)` operator hook #604's period-close
  // will build on: one `adapter.loadAll` read, iterate envelopes, physically
  // `adapter.delete` any `_del` marker with `_ts` older than the cutoff. Genuinely
  // core (touches the adapter contract directly); the load-bearing safety-invariant
  // doc comment accounts for most of the delta.
  // Bumped 3990→3997 (2026-07-09, +7: #589 final-review Fix 4): two doc-comment
  // sentences on `_purgeDeleteMarkers` — ledger/event emission deferred to #604, and
  // local-adapter-only purge scope (operator must purge every sync target too). No
  // behavior change.
  // Bumped 3997→4007 (2026-07-09, +10: #604 Task 3): `vault.freezePeriod(name)`
  // delegator — thin call-site onto `VaultPeriods.freezePeriod`; the freeze logic
  // itself lives in with-audit/periods/vault-facade.ts. Genuinely core (new public
  // Vault method, same tier as closePeriod/openPeriod/getPeriod above it).
  // Bumped 4007→4010 (2026-07-09, +3: #604 final-review Fix I3): restored the
  // local-adapter-only-purge / #589 resurrection-window caveat onto the
  // `freezePeriod` delegator's docstring (trimmed from the shipped version).
  // No behavior change.
  // Bumped 4010→4042 (2026-07-10, #613 period archive): `_archiveClosedPeriod`
  // seam + `archivePeriod` delegator (pure additive, mirrors freezePeriod).
  // Bumped 4042→4082 (2026-07-10, #615 target-purge): `_purgeMarkersOn` extraction
  // (from `_purgeDeleteMarkers`), the `_purgePeriodTargets` seam, `getPurgeableTargets`
  // option/field/default, and the `purgePeriodTargets` delegator (mirrors archivePeriod).
  // Bumped 4082→4084 (2026-07-10, #615 review M1): refreshed the _purgeDeleteMarkers doc comment (pure doc growth, no behavior change).
  // Bumped 4084→4095 (2026-07-11, #623 Task 8: i18n cutover onto the Via pipeline):
  // `enforceI18nOnPut`/`enforceStaticDictOnPut` each gained an `isViaInstalled('i18n')`
  // delegation guard + 9 docstring lines across the two validator delegators explaining it (+11). The two methods' bodies
  // are otherwise unchanged — the inline i18n write/present duplication this task
  // removes lived in collection.ts, not here.
  // Lowered 4095→4094 (2026-07-11, Task 11 re-ratchet, #623 via-port arc):
  // cc9d5830's origin-tagged mutation choke point (kernel/mutation.ts's
  // MutationOrigin + Collection._onRecordMutated dispatch socket for phase
  // C) trimmed vault.ts by one net line as part of the same commit. Locked
  // in to the ACTUAL measured line count — no slack.
  // Lowered 4094→4088 (2026-07-11, Task 11 re-ratchet, #629 via-phase-b arc):
  // net −6 across the phase — Task 6 (classified kernel cutover) −1, Task 9
  // (the exportStream() posture-redaction call site) +1, Task 10 (the six
  // `(coll as any)` casts removed now that `_onViaErase`/`_classifySealedShred`
  // are called directly, typed, plus the forget()-loop posture fallback) −6.
  // Locked in to the ACTUAL measured line count (readFileSync(...).split('\n').length)
  // — no slack.
  // Lowered 4088→3941 (2026-07-12, #650 Task 1 (via-lookup extraction)): the
  // ~350-line dict registry/handle block left vault.ts for
  // via/lookup/{handle,registry,active,index}.ts + the new
  // port/with/lookup-strategy.ts seam — enforceStaticDictOnPut/
  // resolveDictSource/dictionary()'s findAndUpdateReferences closure are now
  // thin delegators, and the dead `applyLocale` (zero production callers,
  // superseded by via.present) was retired outright. Funds the phase's
  // ceiling budget for later tasks.
  // Lowered 3941→3940 (2026-07-12, #650 Task 7, final phase-D re-ratchet):
  // Task 7's one vault.ts change modified the existing Task 6 `snapshotFor`
  // line in place (added a `getCollection` arg for matrix-tier routing) —
  // net zero new lines, so the 1-line slack Task 6 left behind was never
  // spent and is removed here per the checker's ratchet-to-actual
  // convention (phase D's final task). Locked in to the ACTUAL measured
  // line count (readFileSync(...).split('\n').length) — no slack.
  // Lowered 3940→3939 (2026-07-13, via-consolidation Task 6 final re-ratchet,
  // #642/#651/#640/#654): the arc's Task 2 fix wave (#642) funded its
  // `reapplyDependentOverlays` call by collapsing an adjacent `if` block,
  // landing the file 1 line UNDER ceiling; Task 3 (#651) and Task 4 (#654)
  // each landed net-zero edits back at that same actual, never spending the
  // margin. Ratcheting down to the actual per the checker's ratchet-to-actual
  // convention, same reasoning as collection.ts above.
  // Bumped 3939→3950 (2026-07-14, #599 m22 Task 4): `migrateSatellitePerRecordKeys(name)`
  // — a thin call-site (mirrors the `joined()` pattern immediately above it)
  // that opens the satellite collection with `perRecordKeys: true` (bypassing
  // R-S7 by never entering `declareSatellite` — no `satelliteOf` is passed)
  // and delegates the per-record re-encrypt walk to
  // `with-shape/satellites/migrate-cek.ts`. Genuinely core: a new public
  // Vault method, same tier as `runSchemaCutover`/`abortSchemaCutover`.
  // Bumped 3950→3958 (2026-07-15, #653: reserved-dict-deps delegator for partial-sync
  // expansion): `_reservedDictDepsOf(names)` — a thin delegator (same tier as
  // `_reservedLookupCollectionNames()` beside it) to `reservedDictDepsOf` in
  // `via/lookup/registry.ts`, reached through the existing lookup-strategy port import.
  // Bumped 3958→3959 (2026-07-15, #693: tab-coordination fallback for the marker-set gate):
  // one `tabCoordinated: () => this.noydb._tabWritesRelayed` line threaded into collOpts.
  'packages/hub/src/kernel/vault.ts': 3959,
  // Bumped 2920 → 2960 (2026-06): two genuinely-core additions landed —
  // #313's `openVault` no-self-provision pre-gate (a 1-line call; the policy
  // logic itself was extracted to team/keyring.ts as `assertKeyringOpenAllowed`),
  // and the multi-vault federation entry points (`withVaultTemplate` /
  // `openVaultGroup` / `_shardVaultProvisioned` — public `db.*` API; the
  // VaultGroup *implementation* lives in the lazy `federation/` chunk via a
  // dynamic import, NOT here). The extractable parts are already off this file;
  // what remains is irreducible core API + auth surface.
  // Bumped 2960→2995 (2026-06-08): federation control-plane entry points
  // (`openVaultGroup` auto-wire + `openStateManagementVault` factory, #271 L3)
  // and deferred-numbering option threading — public `db.*` API surface; the
  // VaultGroup / StateManagementVault / numbering implementations live in lazy
  // or sibling modules, only the thin entry points are here.
  // Bumped 2995→3070 (#304, forget cascade step 2): the subject-index lifecycle
  // hooks must register at the hub instance level — `#registerForgetHooks`
  // wires an onAfterWrite handler (create/update subject-ref maintenance) AND
  // an `afterDelete` subsystemBus observer (RISK #2: onAfterWrite does not fire
  // on delete, so the bus observer keeps the index from going stale), plus the
  // forgetStrategy field + forwarding to every Vault. The index crypto + the
  // erasure flow live in src/forget/ and vault.ts.
  // Bumped 3070→3085 (2026-06-14, #271 close-out): `_resolveBackend(vaultId)` —
  // the store-resolution seam for the data-residency placement guard. It must
  // live on Noydb (which owns `options.store`); the routing logic itself stays
  // in src/store/route-store.ts (RoutedNoydbStore.resolveBackend).
  // Bumped 3085→3095 (2026-06-15, #412 P3): thread createNoydb({ objectStore })
  // into the three vault-construction option spreads.
  // Bumped 3095→3140 (2026-06-17, FR-6 Task 4): grantCustodian/revokeCustodian —
  // the genuinely-core owner-only custody grant/revoke surface (defended in
  // depth by gate + explicit keyring.role !== 'owner' check).
  // Lowered 3140→3085 (Phase 5 A9: snapshot extraction): `snapshot`/`listSnapshots`/
  // `restoreSnapshot`/`initSnapshotCadence` + the dirty-vault set + cadence scheduler
  // field moved to `with-fork/snapshots/noydb-facade.ts` (`NoydbSnapshots`); noydb.ts
  // holds a facade instance + thin delegators and `close()` calls `snapshots.stop()`.
  // Lowered 3085→3019 (Phase 5 A10: policy/session extraction): `attachPolicyEnforcer`/`touchPolicy`/`checkPolicyOperation`/`getPolicy`/`updatePolicy`/`bootstrapPolicy` bodies moved to `policy/noydb-facade.ts` (`NoydbPolicy`); noydb.ts holds a facade instance + thin delegators (the dead, never-called `attachPolicyEnforcer` is dropped, its body lives on the facade). The session *timer* (`resetSessionTimer` + `sessionTimer` field) and the managed-recovery enrolment check (`assertRecoveryEnrolled`) stay kernel-resident and arrive as callbacks; the policy cache + enforcer map stay noydb-resident (touched by openVault/close) and arrive by reference.
  // Lowered 3019→2275 (Phase 5 A8: auth/recovery/enrollment extraction): the
  // tier-2 authenticator enroll/remove/update/unlock wrappers, WebAuthn enrollment,
  // auth-config introspection, tier-1 passphrase rotate/recover, paper/Shamir recovery
  // rotate/enroll, managed-passphrase recovery, peer-recover, tier-3 PIN unlock, and the
  // public `getKeyring` accessor moved verbatim to `with-party/team/noydb-facade.ts`
  // (`TeamFacade`); noydb.ts holds a facade instance + thin delegators. Pure relocation —
  // the near-parallel rotate/recover variants are NOT consolidated. The keyring/active-tier/
  // quick-unlock/policy caches stay noydb-resident and arrive by reference; the keyring-unlock
  // path (`getKeyringInternal`), policy gate (`checkGate`), managed-recovery enrolment check
  // (`assertRecoveryEnrolled`), `openVault`, and the one-shot managed-recovery skip flag stay
  // kernel-resident and arrive as callbacks.
  // Bumped 2275→2276 (S4 Task 1: gate attestation behind withAttestation()): thread the opt-in
  // `attestationStrategy` from createNoydb options into the two Vault-construction option spreads
  // (async openVault + sync vault()). Public opt-in API surface; the engine lives in the lazy
  // `with-audit/attestation/active.ts` chunk.
  // Bumped 2277→2280 (S4 Task 2: gate tiers behind withTiers()): thread the opt-in `tiersStrategy`
  // from createNoydb options into the three Vault-construction option spreads (async openVault +
  // both sync vault() paths). Public opt-in API surface; the engine lives in the lazy
  // `with-audit/tiers/active.ts` chunk.
  // Bumped 2280→2282 (S4 Task 3: gate sealed-record behind withSealedRecord()): thread the opt-in
  // `sealedRecordStrategy` into the two Vault-construction option spreads (async openVault + sync
  // vault() encrypt===false path), mirroring attestationStrategy. Grantor engine in the lazy
  // `with-audit/sealed-record/active.ts` chunk.
  // Bumped 2282→2284 (S4 Task 4: gate portability behind withPortability()): thread the opt-in
  // `portabilityStrategy` into the two Vault-construction option spreads (async openVault + sync
  // vault() encrypt===false path). Engine in the lazy `with-audit/portability/active.ts` chunk.
  // Bumped 2284→2286 (S4 Task 8: gate sequence behind withSequence()): thread the opt-in
  // `sequenceStrategy` into the two Vault-construction option spreads (async openVault + sync
  // vault() path). Engine in the opt-in `with-commit/sequence/active.ts` chunk.
  // Bumped 2286→2315 (S4 Task 5: gate custody behind withCustody()): custody is gated at the
  // Noydb PRIMITIVE (not just the vault.custody facade) so the gate can't be bypassed via the
  // public `db.grantCustodian`/`db.revokeCustodian`. That requires splitting each into a gated
  // public wrapper (routes through `custodyStrategy`) + a private `_{grant,revoke}CustodianImpl`
  // engine (the original body, reached only when withCustody() is opted in) — the duplicated
  // signatures + `CustodyHost` field + assignment + import account for the +29. The liberate
  // ceremony engine stays in the lazy `with-party/custody/active.ts` chunk.
  // Bumped 2315→2318 (S4 Task 7: gate search behind withSearch()): thread the opt-in
  // `searchStrategy` from createNoydb options into the three Vault-construction option spreads
  // (async openVault + both sync vault() paths). Public opt-in API surface; the search/retrieval
  // engine + embedding write-hook live in the lazy `with-lookup/search/active.ts` chunk.
  // Bumped 2318→2321 (S4 Task 9: gate cargo behind withCargo()): thread the opt-in `cargoStrategy`
  // from createNoydb options into the three Vault-construction option spreads. Public opt-in API
  // surface; the extraction crypto + diff walk live in the lazy `with-cargo/active.ts` chunk.
  // Bumped 2321→2325 (rank-5: kernel/policy/ leaves the kernel for with-party/policy/): the engine/
  // presets/storage/facade implementation (741 LOC) moved out, but noydb.ts itself grew slightly —
  // it now pre-resolves `policyFactory`/`policyCheckGateFn` the same way `userApiFactory` is
  // pre-resolved (dynamic import + ctor guard + a stashed `policyCheckGate` field for the
  // `checkGate` wrapper), same as the user-envelope precedent (commit 19f718eb), which also grew
  // noydb.ts by a few lines for the identical reason: the contract-in-spine + pre-resolved-factory
  // pattern has a fixed per-seam cost on this file even when the bulk of the implementation leaves.
  // Bumped 2325→2327 — 2026-07-04 classified-fields stage 1 Task 6 (reveal gate): thread the opt-in
  // `classifiedStrategy` into the two Vault-construction option spreads.
  // Bumped 2327→2357 — 2026-07-04 #564: single-flight `openVault` (in-flight promise memo +
  // `openVaultFresh` split), so concurrent opens of one vault can no longer construct two
  // key-divergent Vault instances (root cause of the recurring in-pinia TamperedError CI flake).
  // Held 2357 through the #267 team split (grant/revoke/rotate bodies moved
  // to TeamFacade runners + withTeam-linked engines; delegators stayed).
  // Bumped 2357→2360 (2026-07-04, #267 lazy service): three lazyStrategy
  // pass-through spread lines (one per Vault construction site) — standard
  // strategy plumbing, no logic.
  // Bumped 2360→2367 (2026-07-07, #591 satellites archetype-③ — thin call-sites only
  // (declare/joined accessor/proxy wrap/forget ref-expansion/pair-sync hooks); heavy
  // logic in with-shape/satellites): documented actual post-implementation line count.
  // Bumped 2367→2371 (2026-07-09): #598 sync cache-invalidation wiring
  // (vault._invalidateSyncApplied + openVault hook) — a 4-line
  // `_forEachSyncEngine(name, …setCacheInvalidator…)` hookup directly after
  // the openVault Vault construction. Thin call-site; the invalidation itself
  // lives on Vault/Collection and the engine in with-party/team/.
  // Bumped 2371→2375 (2026-07-10, #615 target-purge): `getPurgeableTargets`
  // pass-through at the sync-configured Vault construction site — thin
  // call-site, filters/maps the already-computed `targets` array.
  // Bumped 2375→2385 (2026-07-10, #616): role-gate the sync primary (emptyPullResult
  // factory + pull() no-op + sync() primary ternary branch for push-only sinks).
  // Bumped 2385→2396 (2026-07-15, #693: tab-coordination fallback for the marker-set gate):
  // `_tabCoordinationActive` internal live getter (`tabCoordinator !== undefined`) — the
  // dynamic signal Vault threads into every Collection so the #606 re-create gate can fall
  // back to an unconditional store read whenever multi-tab coordination is active at all
  // (presence/election alone or full write-propagation), not only while writes are relayed
  // (review fix: `propagateWrites: false` left `writeRelay` unset, so the narrower signal
  // missed a peer tab's delete-marker on a shared store — permanent #589-class data loss).
  'packages/hub/src/kernel/noydb.ts': 2396,
}

function checkKernelSurface() {
  for (const [rel, ceiling] of Object.entries(KERNEL_SURFACE_BUDGET)) {
    const file = join(ROOT, rel)
    if (!existsSync(file)) {
      fail('kernel-surface', `${rel} not found — update KERNEL_SURFACE_BUDGET if the file moved or was renamed.`, file)
      continue
    }
    // NB: split('\n').length = (newline count) + 1, so this reads one MORE
    // than `wc -l` on trailing-newline files. Ceilings are calibrated against
    // this metric — keep using it when ratcheting so the numbers stay aligned.
    const lines = readFileSync(file, 'utf8').split('\n').length
    if (lines > ceiling) {
      fail(
        'kernel-surface',
        `${rel} is ${lines} lines, over its ${ceiling}-line kernel-surface ceiling (+${lines - ceiling}). The always-on kernel must stay lean — move new capability into a service that registers on the SubsystemBus instead of growing this file. If the growth is genuinely core, raise the ceiling in scripts/check-architecture.mjs with justification.`,
        file,
      )
    }
  }
}

// ─── Check 8: no-outbound-klum-import (NO @noy-db package may depend on @klum-db) ───
function checkNoOutboundKlumImport() {
  // The dependency runs ONE way: @klum-db/* (orchestration) → @noy-db/* (vault).
  // No @noy-db package — hub core OR any edge adapter (e.g. as-xlsx, FR-9) — may
  // import @klum-db. Scan every package's src EXCEPT the @klum-db packages
  // themselves (which legitimately import each other / re-export klum symbols).
  //
  // Use stripComments (NOT stripCommentsAndStrings): import specifiers ARE
  // string literals — blanking string bodies makes this a no-op. Line-anchor
  // to real import/export statements so FederationMovedError's runtime message
  // (which contains "from '@klum-db/lobby'" mid-line) doesn't false-positive.
  //
  // Accepted limitation: a hand-split multi-line import where `from` lands on
  // a `}`-leading line is NOT matched. That's fine — no @noy-db package declares
  // @klum-db/* as a dependency, so any real outbound import also fails that
  // package's build/typecheck (hard backstop that covers the multi-line edge case).
  const klumStatic = /^\s*(?:import|export)\b[^\n]*?\bfrom\s+['"]@klum-db\//m
  const klumDynamic = /\bimport\s*\(\s*['"]@klum-db\//
  for (const pkgDir of listPackageDirs()) {
    let name
    try { name = readPackageJson(pkgDir).name } catch { continue }
    if (typeof name === 'string' && name.startsWith('@klum-db/')) continue // klum packages may import klum
    walkTsFiles(join(pkgDir, 'src'), (file, content) => {
      const code = stripComments(content)
      if (klumStatic.test(code) || klumDynamic.test(code)) {
        fail(
          'no-outbound-klum-import',
          `${relative(ROOT, file)} imports from @klum-db. No @noy-db package (hub core OR edge adapter) may depend on the orchestration package — the dependency runs the other way (@klum-db/lobby depends on @noy-db/hub/cargo + edge adapters).`,
          file,
        )
      }
    })
  }
}

// ─── Check 7: no debugPlaintext in shipped library source (#413 P3) ─────

/**
 * `debugPlaintext: true` stores records UNENCRYPTED, laid out for native store
 * inspection — a consumer-set, dev-only option. No shipped library source under
 * `packages/*​/src` should hardcode it on. Tests (`__tests__`) and showcases
 * (`showcases/`) live outside `packages/*​/src` and may set it freely.
 */
function checkNoDebugPlaintextInSource() {
  const re = /debugPlaintext\s*:\s*true/
  for (const pkgDir of listPackageDirs()) {
    walkTsFiles(join(pkgDir, 'src'), (file, content) => {
      if (re.test(stripComments(content))) {
        fail(
          'no-debug-plaintext-in-source',
          `${relative(ROOT, file)} hardcodes "debugPlaintext: true" — it stores records UNENCRYPTED and is a dev-only consumer option; never ship it on in library source.`,
          file,
        )
      }
    })
  }
}

// ─── Check 9: port-layering (S5 family ports) ────────────────────────────
//
// Imports point inward only: family → port → service layer → kernel spine
// → enclave. The kernel spine (the always-on orchestration files: noydb.ts,
// vault.ts, collection.ts, types.ts, errors.ts, schema.ts, refs.ts,
// validation.ts, collection-config.ts, write-queue.ts, constants.ts,
// events.ts, debug.ts, env-check.ts, plus query/ enclave/ cache/ util/
// meta/ policy/ — all of `src/kernel/**`) may import its own `port/with/`
// hook seam freely, but must not statically reach into a `with-*` service
// package or another family port (`to on at in by ui as`, discovered at
// `src/port/*`) — see
// docs/superpowers/specs/2026-07-02-family-doors-kernel-diet-design.md.
// A dynamic `import()` is the sanctioned escape hatch (the S4 gate recipe);
// this check only scans static `import`/`export … from` statements.
//
// `as` is the layer port (a sibling of `with-cargo`/`with-pod`, not a
// `kernel/<name>` barrel) — it may import `with-*` services directly. This
// check never restricted port→with-* imports in the first place (only
// port→port and spine→port/with-*), so `as` needs no special-casing beyond
// being folded into the same port list as the others.
//
// PRE_EXISTING_SPINE_SERVICE_IMPORTS grandfathers the with-* call-sites that
// predate this check: the S4 NO_X-strategy-default / thin-facade-delegator
// pattern (documented at length in KERNEL_SURFACE_BUDGET above) plus the
// query DSL's aggregate/money reducers. Retrofitting those ~280 call-sites
// is its own future extraction effort (see the design doc's "Deferred" list),
// not this task's job — this is a ratchet against NEW spine→service
// coupling, not a retroactive fix.
//
// Grandfathered PER IMPORT SPECIFIER, not per file: each entry maps a spine
// file to the exact list of with-*/port import specifiers it already had
// when this check landed. A grandfathered file adding a NEW spine→service
// import that isn't in its list still fails — only the frozen baseline is
// exempt. A file not in this map must stay clean (no with-*/port imports at
// all). Regenerate an entry's list only when deliberately retiring one of
// its existing grandfathered imports (never to silently add a new one).

const FAMILY_PORTS = ['to', 'on', 'at', 'in', 'by', 'ui', 'as'] // `with` is the exception port — never restricted.

const PRE_EXISTING_SPINE_SERVICE_IMPORTS = new Map([
  ['packages/hub/src/kernel/collection-config.ts', [
    '../with-audit/guards/types.js',
    '../with-audit/tiers/strategy.js',
    '../with-commit/crdt/crdt.js',
    '../with-commit/crdt/strategy.js',
    '../with-commit/history/ledger/index.js',
    '../with-commit/history/strategy.js',
    '../with-commit/tx/transaction.js',
    '../with-formula/computed/index.js',
    '../with-formula/derivations/registry.js',
    '../with-formula/materialized-views/registry.js',
    '../with-formula/materialized-views/types.js',
    '../with-lookup/aggregate/strategy.js',
    '../with-lookup/embeddings/index.js',
    '../with-lookup/indexing/eager-indexes.js',
    '../with-lookup/indexing/strategy.js',
    '../with-lookup/search/strategy.js',
    '../with-party/team/keyring.js',
    '../with-party/team/sync-strategy.js',
    '../with-shape/blobs/blob-compaction.js',
    '../with-shape/blobs/object-projection.js',
    // classified stage 2 Task 13 (2026-07-04) — refusal matrix R1-R5 guard at
    // door 1 (config resolution); pure validation, same ③ class as resolve.js
    '../via/classified/guards.js',
    // classified-fields stage 1 — ③ schema feature, joins the #553 lazy-import debt like money/dictKey/computed
    '../via/classified/resolve.js',
    '../with-shape/introspection/field-meta.js',
    '../with-shape/introspection/meta.js',
    '../with-shape/schema-update/fence-controller.js',
    '../with-shape/schema-update/gate.js',
  ]],
  ['packages/hub/src/kernel/collection.ts', [
    '../with-audit/guards/types.js',
    '../with-audit/tiers/index.js',
    '../with-audit/tiers/strategy.js',
    '../with-commit/crdt/crdt.js',
    '../with-commit/crdt/strategy.js',
    '../with-commit/history/diff.js',
    '../with-commit/history/ledger/index.js',
    '../with-commit/history/strategy.js',
    '../with-commit/tx/transaction.js',
    '../with-formula/computed/index.js',
    // #553 -- tiny lazy-loader seam; the computed engine itself now dynamic-imports
    '../with-formula/computed/lazy.js',
    '../with-formula/derivations/executor.js',
    '../with-formula/derivations/fanout-sidecar.js',
    '../with-formula/derivations/registry.js',
    '../with-formula/derivations/stale.js',
    '../with-formula/materialized-views/executor.js',
    '../with-formula/materialized-views/registry.js',
    '../with-formula/materialized-views/stale.js',
    '../with-formula/materialized-views/types.js',
    '../with-lookup/aggregate/strategy.js',
    '../with-lookup/embeddings/index.js',
    '../with-lookup/indexing/collection-facade.js',
    '../with-lookup/indexing/eager-indexes.js',
    '../with-lookup/indexing/lazy-builder.js',
    '../with-lookup/indexing/persisted-indexes.js',
    '../with-lookup/indexing/strategy.js',
    '../with-lookup/indexing/unique-constraints.js',
    '../with-lookup/search/collection-facade.js',
    '../with-lookup/search/index-store.js',
    '../with-lookup/search/index.js',
    '../with-lookup/search/persisted-index-store.js',
    '../with-lookup/search/retrieve-types.js',
    '../with-lookup/search/strategy.js',
    '../with-party/team/keyring.js',
    '../with-party/team/presence.js',
    '../with-party/team/sync-strategy.js',
    '../with-pod/ulid.js',
    '../with-shape/blobs/blob-compaction.js',
    '../with-shape/blobs/blob-set.js',
    '../with-shape/blobs/object-projection.js',
    // classified-fields stage 1 — ③ schema feature, joins the #553 lazy-import debt like money/dictKey/computed
    '../via/classified/resolve.js',
    '../via/classified/write.js',
    // classified-fields stage 1 Task 6 — typed reveal() error, sibling of the ③ write-path errors
    '../via/classified/errors.js',
    // classified stage 2 Task 13 (2026-07-04) — refusal matrix R1-R5 guard at
    // door 2 (the _applyClassifiedFields reconcile seam); pure validation, same ③ class as resolve.js
    '../via/classified/guards.js',
    '../with-shape/introspection/describe.js',
    '../with-shape/introspection/field-meta.js',
    '../with-shape/introspection/meta.js',
    '../with-shape/introspection/types.js',
    '../with-shape/persisted-schemas/derive.js',
    '../with-shape/schema-update/fence-controller.js',
    '../with-shape/schema-update/gate.js',
  ]],
  ['packages/hub/src/kernel/noydb.ts', [
    '../with-audit/forget/strategy.js',
    '../with-audit/forget/subject-index.js',
    '../with-commit/tx/dry-run.js',
    '../with-commit/tx/strategy.js',
    '../with-commit/tx/transaction.js',
    '../with-fork/snapshots/noydb-facade.js',
    '../with-fork/snapshots/strategy.js',
    '../with-party/custody/strategy.js',
    '../with-party/directory/public-envelope/schema.js',
    '../with-party/directory/public-envelope/types.js',
    '../with-party/directory/storage.js',
    '../with-party/session/session-policy.js',
    '../with-party/session/strategy.js',
    '../with-party/session/unlock-state.js',
    '../with-party/tab-coordination.js',
    '../with-party/tab-write-relay.js',
    '../with-party/team/authenticators.js',
    '../with-party/team/keyring.js',
    '../with-party/team/managed-passphrase.js',
    '../with-party/team/noydb-facade.js',
    '../with-party/team/peer-recover.js',
    '../with-party/team/recovery.js',
    '../with-party/team/rotate-recover.js',
    '../with-party/team/sync-strategy.js',
    '../with-party/team/sync-transaction.js',
    '../with-party/team/sync.js',
    '../with-pod/ulid.js',
    '../with-shape/introspection/meta.js',
    '../port/by/default-provider.js',
  ]],
  ['packages/hub/src/kernel/types.ts', [
    '../with-audit/attestation/strategy.js',
    '../with-audit/consent/strategy.js',
    '../with-audit/forget/strategy.js',
    '../with-audit/guards/types.js',
    '../with-audit/periods/strategy.js',
    '../with-audit/portability/strategy.js',
    '../with-audit/sealed-record/strategy.js',
    '../with-audit/tiers/strategy.js',
    '../with-cargo/strategy.js',
    '../with-commit/crdt/crdt.js',
    '../with-commit/crdt/strategy.js',
    '../with-commit/history/strategy.js',
    '../with-commit/numbering/descriptor.js',
    '../with-commit/sequence/strategy.js',
    '../with-commit/tx/strategy.js',
    '../with-fork/archive/index.js',
    '../with-fork/shadow/strategy.js',
    '../with-fork/snapshots/strategy.js',
    '../with-formula/derivations/types.js',
    '../with-formula/materialized-views/types.js',
    '../with-formula/overlay-views/types.js',
    '../with-lookup/aggregate/strategy.js',
    '../with-lookup/indexing/strategy.js',
    '../with-lookup/search/strategy.js',
    '../with-party/custody/strategy.js',
    '../with-party/directory/public-envelope/types.js',
    '../with-party/session/strategy.js',
    '../with-party/team/keyring.js',
    '../with-party/team/managed-passphrase.js',
    '../with-party/team/shamir-recovery-provider.js',
    '../with-party/team/sync-strategy.js',
    '../with-shape/blobs/object-projection.js',
    '../port/by/types.js',
  ]],
  ['packages/hub/src/kernel/vault.ts', [
    '../with-audit/attestation/vault-facade.js',
    '../with-audit/consent/consent.js',
    '../with-audit/consent/strategy.js',
    '../with-audit/forget/strategy.js',
    '../with-audit/forget/subject-index.js',
    '../with-audit/guards/read-only-facade.js',
    '../with-audit/guards/registry.js',
    '../with-audit/guards/types.js',
    '../with-audit/periods/index.js',
    '../with-audit/periods/strategy.js',
    '../with-audit/periods/vault-facade.js',
    '../with-audit/portability/strategy.js',
    '../with-audit/sealed-record/strategy.js',
    '../with-audit/tiers/strategy.js',
    '../with-cargo/strategy.js',
    '../with-commit/crdt/crdt.js',
    '../with-commit/crdt/strategy.js',
    '../with-commit/history/ledger/entry.js',
    '../with-commit/history/ledger/store.js',
    '../with-commit/history/strategy.js',
    '../with-commit/history/time-machine.js',
    '../with-commit/numbering/descriptor.js',
    '../with-commit/numbering/index.js',
    '../with-commit/sequence/index.js',
    '../with-commit/sequence/strategy.js',
    '../with-commit/tx/elevated-handle.js',
    '../with-fork/archive/index.js',
    '../with-fork/shadow/strategy.js',
    '../with-fork/shadow/vault-frame.js',
    '../with-formula/computed/index.js',
    '../with-formula/derivations/registry.js',
    '../with-formula/derivations/types.js',
    '../with-formula/materialized-views/registry.js',
    '../with-formula/materialized-views/types.js',
    '../with-formula/overlay-views/registry.js',
    '../with-formula/overlay-views/types.js',
    '../with-formula/overlay-views/virtual-collection.js',
    '../with-lookup/aggregate/strategy.js',
    '../with-lookup/embeddings/index.js',
    '../with-lookup/indexing/eager-indexes.js',
    '../with-lookup/indexing/strategy.js',
    '../with-lookup/search/strategy.js',
    '../with-party/custody/index.js',
    '../with-party/directory/public-envelope/types.js',
    '../with-party/team/delegation.js',
    '../with-party/team/keyring.js',
    // reserved-secret-collection guard (security fix) — the collection() door
    // rejects secret-bearing reserved names; sibling of the grandfathered
    // reserved-name predicates i18n/dictionary.js and links/names.js below.
    '../with-party/team/reserved-secret-collections.js',
    '../with-party/team/magic-link-grant.js',
    '../with-party/team/managed-passphrase.js',
    '../with-party/team/sync-strategy.js',
    '../with-shape/blobs/blob-compaction.js',
    '../with-shape/blobs/export-blobs.js',
    '../with-shape/blobs/object-projection.js',
    // classified-fields stage 1 — ③ schema feature, joins the #553 lazy-import debt like money/dictKey/computed
    '../via/classified/resolve.js',
    '../with-shape/introspection/field-meta.js',
    '../with-shape/introspection/meta.js',
    '../with-shape/introspection/types.js',
    '../with-shape/introspection/walk.js',
    // #553 -- always-loadable links slice (naming/types + the lazy handle
    // factory); the LinkSet storage engine itself now dynamic-imports
    '../with-shape/links/lazy-handle.js',
    '../with-shape/links/names.js',
    '../with-shape/links/vault-facade.js',
    // #591 satellites — ③ schema feature (declare/joined accessor/proxy wrap/
    // forget ref-expansion), thin call-sites only; heavy logic in with-shape/satellites
    '../with-shape/satellites/declare.js',
    '../with-shape/satellites/forget.js',
    '../with-shape/satellites/joined.js',
    '../with-shape/satellites/proxy.js',
    '../with-shape/satellites/registry.js',
    '../with-shape/satellites/types.js',
    '../with-shape/schema-update/fence-controller.js',
    '../with-shape/schema-update/fence-watcher.js',
    '../with-shape/schema-update/fence.js',
    '../with-shape/schema-update/gate.js',
    '../with-shape/schema-update/types.js',
  ]],
  ['packages/hub/src/kernel/query/builder.ts', [
    '../../with-lookup/aggregate/aggregation.js',
    '../../with-lookup/aggregate/groupby.js',
    '../../with-lookup/aggregate/reducers.js',
    '../../with-lookup/aggregate/strategy.js',
    '../../with-lookup/indexing/eager-indexes.js',
  ]],
  ['packages/hub/src/kernel/query/index.ts', [
    '../../with-lookup/aggregate/aggregation.js',
    '../../with-lookup/aggregate/groupby.js',
    '../../with-lookup/aggregate/reducers.js',
    '../../with-lookup/indexing/eager-indexes.js',
  ]],
  ['packages/hub/src/kernel/query/scan-builder.ts', [
    '../../with-lookup/aggregate/aggregation.js',
    '../../with-lookup/aggregate/reducers.js',
  ]],
  ['packages/hub/src/kernel/enclave/record-keys/record-codec.ts', [
    '../../../with-commit/crdt/crdt.js',
    '../../../with-commit/crdt/strategy.js',
  ]],
  ['packages/hub/src/kernel/enclave/record-keys/sealing.ts', [
    '../../../with-audit/sealed-record/types.js',
    '../../../with-party/team/managed-passphrase.js',
  ]],
])

// Matches a static `import`/`export … from '…'` clause (named `{…}`,
// `* as x`, bare `*`, or a default binding optionally combined with a named
// or namespace clause, e.g. `import x from '…'` / `import x, { y } from
// '…'`); multi-line clauses are fine since `[^}]` already spans newlines.
// Dynamic `import(…)` calls never match (no `from`).
const STATIC_IMPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+\S+|\{[^}]*\}|\*|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+\S+|\{[^}]*\}))?)\s*from\s*['"]([^'"]+)['"]/g

// Matches a side-effect-only static import — `import '…'` (no binding
// clause, no `from` keyword) — which STATIC_IMPORT_FROM_RE can never match
// since it requires `from`. #632.
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g

/**
 * All static import/export specifiers in `code` — both `… from '…'` clauses
 * (STATIC_IMPORT_FROM_RE) and side-effect-only `import '…'` statements
 * (SIDE_EFFECT_IMPORT_RE). #632: the two forms used to be scanned
 * separately (and side-effect imports not at all); every layering guard
 * below now goes through this single helper so both are always covered
 * together.
 */
function* staticImportSpecs(code) {
  for (const m of code.matchAll(STATIC_IMPORT_FROM_RE)) yield m[1]
  for (const m of code.matchAll(SIDE_EFFECT_IMPORT_RE)) yield m[1]
}

/** Path of a resolved import, relative to `hub/src`, POSIX-separated. */
function importTargetRelToHubSrc(fromFile, spec, hubSrc) {
  return relative(hubSrc, resolve(dirname(fromFile), spec)).split('\\').join('/')
}

function checkPortLayering() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const kernelDir = join(hubSrc, 'kernel')
  const portDir = join(hubSrc, 'port')

  // Rule 1: the spine must not statically import a with-* service package
  // or a family port — except its own `port/with/` hook seam. No more
  // subdir exclusions are needed inside `kernel/`: every port moved out
  // to `src/port/` and the deprecated `/adapter` alias moved out to
  // `src/legacy/`, so a full recursive walk of `kernel/` is the spine.
  const spineFiles = []
  walkTsFiles(kernelDir, (file) => spineFiles.push(file))
  for (const file of spineFiles) {
    const rel = relative(ROOT, file)
    const allowedImports = PRE_EXISTING_SPINE_SERVICE_IMPORTS.get(rel)
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const spec of staticImportSpecs(code)) {
      if (!spec.startsWith('.')) continue // only relative imports resolve inside hub/src
      if (allowedImports?.includes(spec)) continue // frozen baseline import — grandfathered
      const target = importTargetRelToHubSrc(file, spec, hubSrc)
      if (/^with-[^/]+(\/|$)/.test(target)) {
        fail(
          'port-layering',
          `${rel} statically imports service-layer path "${spec}" — the kernel spine may only reach a with-* service via a dynamic import() (the S4 gate recipe).`,
          file,
        )
      } else if (target.startsWith('port/with/')) {
        // sanctioned exception — the spine may reach its own hook seam freely
      } else if (target.startsWith('port/')) {
        fail(
          'port-layering',
          `${rel} statically imports family port "${spec}" — the kernel spine may not import a port folder (port/with/ is the only exception).`,
          file,
        )
      }
    }
  }

  // Rule 2: a family port may not import another family port. `with` is
  // exempt both ways (spine→with and port→with are always allowed). `as`
  // is folded into the same list as the rest — this rule only checks
  // port-vs-port imports, so it never touches `as`'s with-cargo/with-pod
  // imports (the layer-port exception the old check documented as
  // "unexamined because it lived outside kernel/" — same outcome here,
  // just because this rule doesn't restrict port→with-* at all).
  for (const portName of FAMILY_PORTS) {
    walkTsFiles(join(portDir, portName), (file, content) => {
      const rel = relative(ROOT, file)
      const code = stripComments(content)
      for (const spec of staticImportSpecs(code)) {
        if (!spec.startsWith('.')) continue
        const target = importTargetRelToHubSrc(file, spec, hubSrc)
        if (target.startsWith('port/with/')) continue // the hook seam — always an allowed target
        const targetPort = FAMILY_PORTS.find((d) => d !== portName && target.startsWith(`port/${d}/`))
        if (targetPort) {
          fail(
            'port-layering',
            `${rel} (port/${portName}/) statically imports port/${targetPort}/ — family ports may not import each other.`,
            file,
          )
        }
      }
    })
  }
}

// ─── Check 10: enclave-barrel-only (S5 family doors) ────────────────────
//
// kernel/enclave/ (crypto.ts + record-keys/**) is the hub's crypto
// interior — the piece a forked sister project replaces wholesale,
// honoring only kernel/enclave/index.ts (the barrel, THE fork-swap
// contract). A file outside kernel/enclave/** that statically imports an
// enclave path deeper than the barrel (e.g. './enclave/crypto.js' or
// '../kernel/enclave/record-keys/index.js') reaches around that contract.
// Only hub/src is scanned — tests aren't architecture-bound, though they
// were migrated to the barrel too for consistency. Only static
// `import`/`export … from` clauses are checked; a dynamic `import()` is
// not statically analyzable here (same carve-out as port-layering above).
//
// The reverse direction (C3 — self-contained folder, Enclave Contract v1):
// a file INSIDE kernel/enclave/** may import only spine types (kernel/**,
// port/**) — never a with-* service. Contract types a service used to hand
// the enclave (CRDT mode/state/strategy, RecipientSealer, the sealed-CEK
// wire types) are hoisted into kernel/types.ts precisely so this direction
// can be zero.

function checkEnclaveBarrelOnly() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const enclaveDir = join(hubSrc, 'kernel', 'enclave')

  walkTsFiles(hubSrc, (file, content) => {
    const rel = relative(ROOT, file)
    const insideEnclave = !relative(enclaveDir, file).startsWith('..')
    const code = stripComments(content)

    for (const spec of staticImportSpecs(code)) {
      if (!spec.startsWith('.')) continue
      const target = importTargetRelToHubSrc(file, spec, hubSrc)

      if (insideEnclave) {
        if (/^with-[^/]+(\/|$)/.test(target)) {
          fail(
            'enclave-barrel-only',
            `${rel} statically imports service-layer path "${spec}" — kernel/enclave/** must be self-contained (C3): it may import only spine types, never a with-* service. Hoist the contract type into kernel/types.ts and re-export it from the service instead.`,
            file,
          )
        }
        continue // internal (relative-within-enclave) imports are the barrel's own business
      }

      if (target.startsWith('kernel/enclave/') && target !== 'kernel/enclave/index.js') {
        fail(
          'enclave-barrel-only',
          `${rel} statically imports "${spec}" — reaches past the enclave barrel. Import from kernel/enclave/index.js instead; it is the fork-swap contract a sister project replaces wholesale.`,
          file,
        )
      }
    }
  })
}

// ─── Check 11: enclave-body-only (C1 — protected-body access ratchet) ──
//
// Enclave Contract v1 splits the envelope into a protocol header (family-
// owned: `_noydb`/`_v`/`_ts`/`_by`/`_source`/`_sourceTs`/`_tier`/
// `_elevatedBy` — stores/sync/history/klum read these freely) and a
// protected body (`_iv`/`_data`/`_cek`/`_det`/`_sealed`/`_debug` — enclave
// territory). Only `kernel/enclave/**` may read or construct these body
// fields; everyone else goes through the barrel helpers
// (`openEnvelopeJson`/`writeEnvelopeBody`/`hasPerRecordKey`/
// `envelopeBodyForHash`, per the design doc).
//
// The 2026-07-03 audit found ~121 direct accesses across ~55 non-enclave
// files predating this check — too many to fix in one PR. This is a
// RATCHET, not a hard ban: PRE_EXISTING_BODY_ACCESS grandfathers each
// offending file at its scanned-at-implementation-time count. Migration
// (Tasks 6-7) shrinks these counts in review-gated batches; the map
// reaching all-zero (empty) is the definition of C1 done.
//
// Equality semantics (mirrors KERNEL_SURFACE_BUDGET's ratchet, but per-file
// and exact rather than a ceiling): the STORED count must always equal the
// ACTUAL count.
//   - actual > stored  → FAIL: new protected-body access outside the enclave.
//   - actual < stored  → FAIL: the count drifted down without banking the
//                        win — a real reduction must be reflected in the map,
//                        or the ratchet can't tell a genuine shrink from a
//                        scanner blind spot.
//   - actual === stored → clean.
//   - actual > 0 and the file isn't in the map at all → FAIL (same as
//     actual > stored, with stored implicitly 0 — a brand-new file may not
//     introduce protected-body access without an explicit, reviewed entry).
//
// Detection: property access (`env._iv`, `envelope._data`, …) via a literal
// `.` + field name + word boundary, OR object-literal key construction
// (`_iv: …`, `_data: …`, …). Like `checkEnclaveBarrelOnly` and
// `checkPortLayering`, this uses `stripComments` (not
// `stripCommentsAndStrings`) — field mentions inside JSDoc/comments don't
// count, but a field name appearing inside a string literal (e.g. an error
// message) would. That's an accepted, understood overcount: it keeps this
// check's helpers identical to its siblings, and any such site is rare and
// stable, so the ratchet doesn't flap. `*.test.ts` files are excluded (tests
// aren't architecture-bound) as is everything under `kernel/enclave/**`
// (that's the barrel's own home turf).

const BODY_FIELD_ACCESS_RE =
  /\._iv\b|\._data\b|\._cek\b|\._det\b|\._sealed\b|\._debug\b|\b_iv\s*:|\b_data\s*:|\b_cek\s*:|\b_det\s*:|\b_sealed\s*:|\b_debug\s*:/g

// Snapshotted 2026-07-03 by running the scanner below in report mode over
// `packages/hub/src/**` (excluding `kernel/enclave/**` and `*.test.ts`).
// 53 files, 337 occurrences (incl. _debug). Shrink an entry (or delete it at 0) as Tasks
// 6-7 migrate call-sites onto the barrel helpers — never raise one without
// a reviewed, justified new direct access.
const PRE_EXISTING_BODY_ACCESS = new Map([
  ['packages/hub/src/kernel/debug.ts', 4],
  ['packages/hub/src/kernel/types.ts', 2],
  ['packages/hub/src/kernel/vault.ts', 13],
  ['packages/hub/src/with-audit/attestation/issue.ts', 2],
  ['packages/hub/src/with-audit/attestation/revoke.ts', 2],
  ['packages/hub/src/with-audit/attestation/signer.ts', 2],
  ['packages/hub/src/with-audit/consent/consent.ts', 5],
  ['packages/hub/src/with-audit/forget/subject-index.ts', 7],
  // #604 Task 3: `readReserved()` — generic reserved-collection reader added
  // alongside `writeReserved()` (DRY'd from the old `writePeriodRecord`) to
  // also serve the `_period_freezes` companion. Its plaintext fallback
  // (`env._data`) mirrors the identical established ternary idiom already
  // used in with-shape/links/link-set.ts and with-commit/{numbering,sequence}/index.ts
  // (`this.encrypted ? await openEnvelopeJson(...) : env._data`) — reviewed,
  // not a new pattern.
  ['packages/hub/src/with-audit/periods/vault-facade.ts', 6],
  ['packages/hub/src/with-audit/portability/request-withdrawal.ts', 4],
  ['packages/hub/src/with-audit/portability/withdraw-accessible.ts', 2],
  ['packages/hub/src/with-audit/sealed-record/index.ts', 4],
  // #635: `getAtTier`'s tier>0 leg now processes `_sealed` slots (reads
  // `envelope._sealed` to detect + forward the blob map to
  // `RecordCodec.applySealedSlots`) — 2 new accesses, reviewed & justified
  // (parity with the tier-0 leg, which already goes through `decryptRecord`'s
  // own `_sealed` handling).
  ['packages/hub/src/with-audit/tiers/index.ts', 24],
  ['packages/hub/src/with-cargo/adopt-partition.ts', 8],
  ['packages/hub/src/with-cargo/extract-partition.ts', 26],
  ['packages/hub/src/with-commit/history/history.ts', 2],
  ['packages/hub/src/with-commit/history/ledger/store.ts', 11],
  ['packages/hub/src/with-commit/history/time-machine.ts', 3],
  ['packages/hub/src/with-commit/numbering/index.ts', 5],
  ['packages/hub/src/with-commit/sequence/index.ts', 5],
  ['packages/hub/src/with-formula/derivations/fanout-sidecar.ts', 6],
  ['packages/hub/src/with-party/auth-introspection/index.ts', 1],
  ['packages/hub/src/with-party/custody/liberate.ts', 2],
  ['packages/hub/src/with-party/directory/public-envelope/storage.ts', 3],
  ['packages/hub/src/with-party/directory/storage.ts', 3],
  ['packages/hub/src/with-party/directory/user-envelope/storage.ts', 2],
  ['packages/hub/src/with-party/directory/visibility.ts', 3],
  ['packages/hub/src/with-party/policy/storage.ts', 3],
  ['packages/hub/src/with-party/team/deed.ts', 3],
  ['packages/hub/src/with-party/team/delegation.ts', 2],
  ['packages/hub/src/with-party/team/keyring.ts', 14],
  ['packages/hub/src/with-party/team/magic-link-grant.ts', 2],
  ['packages/hub/src/with-party/team/managed-passphrase.ts', 3],
  ['packages/hub/src/with-party/team/peer-recover.ts', 3],
  ['packages/hub/src/with-party/team/presence.ts', 3],
  ['packages/hub/src/with-party/team/recovery.ts', 6],
  ['packages/hub/src/with-party/team/rotate-recover.ts', 5],
  ['packages/hub/src/with-party/team/sync-credentials.ts', 2],
  ['packages/hub/src/with-party/team/sync.ts', 3],
  ['packages/hub/src/with-pod/backup.ts', 3],
  ['packages/hub/src/with-pod/bundle.ts', 2],
  ['packages/hub/src/with-shape/blobs/blob-compaction.ts', 4],
  ['packages/hub/src/with-shape/blobs/blob-set.ts', 33],
  // #629 Task 4: DictionaryHandle's encrypt/decrypt now goes through the
  // reservedEnvelopes('_dict_') capability instead of building `_iv`/`_data`
  // literals inline — down from 5 (the plaintext branch's `_iv: ''`/`_data:`
  // + decryptEntry's `envelope._data` read remain; the two-occurrence
  // encrypted-branch envelope literal moved into kernel/enclave/).
  // #650 Task 1: DictionaryHandle (renamed LookupHandle) moved wholesale to
  // via/lookup/handle.ts — this entry retargets with it (same 3:
  // plaintext-branch `_iv: ''`/`_data:` + decryptEntry's `envelope._data`
  // read). via/i18n/dictionary.ts now re-exports the class and has 0.
  ['packages/hub/src/via/lookup/handle.ts', 3],
  ['packages/hub/src/with-shape/introspection/walk.ts', 1],
  ['packages/hub/src/with-shape/links/link-set.ts', 5],
  ['packages/hub/src/with-shape/persisted-schemas/storage.ts', 2],
  // #591 satellites — existence authority (spec § Convergence & existence
  // authority, rule 1): one undecrypted envelope-shape check (`_iv === '' &&
  // _data === ''`, mirroring the tombstone shape) on the store's raw `get()`.
  // No `encrypted` flag is threaded to existence.ts's call sites, so
  // isTombstone()'s two-arg contract doesn't drop in cleanly; reviewed as a
  // deliberate, narrow exception rather than growing the barrel's contract.
  ['packages/hub/src/with-shape/satellites/existence.ts', 2],
  ['packages/hub/src/with-shape/schema-update/client-registry.ts', 3],
  ['packages/hub/src/with-shape/schema-update/fence.ts', 3],
  ['packages/hub/src/with-store/route-store.ts', 1],
  ['packages/hub/src/with-store/store-middleware.ts', 1],
])

function checkEnclaveBodyOnly() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const enclaveDir = join(hubSrc, 'kernel', 'enclave')

  const actualCounts = new Map()
  walkTsFiles(hubSrc, (file, content) => {
    if (file.endsWith('.test.ts')) return
    const insideEnclave = !relative(enclaveDir, file).startsWith('..')
    if (insideEnclave) return
    const code = stripComments(content)
    const matches = code.match(BODY_FIELD_ACCESS_RE)
    if (matches && matches.length > 0) {
      actualCounts.set(relative(ROOT, file), matches.length)
    }
  })

  const allFiles = new Set([...actualCounts.keys(), ...PRE_EXISTING_BODY_ACCESS.keys()])
  for (const rel of allFiles) {
    const actual = actualCounts.get(rel) ?? 0
    const stored = PRE_EXISTING_BODY_ACCESS.get(rel)
    const file = join(ROOT, rel)

    if (stored === undefined) {
      fail(
        'enclave-body-only',
        `${rel} has ${actual} protected-body field access(es) (_iv/_data/_cek/_det/_sealed) but is not in PRE_EXISTING_BODY_ACCESS — only kernel/enclave/** may read or construct these fields directly. Go through the enclave barrel helpers (openEnvelopeJson/writeEnvelopeBody/hasPerRecordKey/envelopeBodyForHash), or if this is a deliberate grandfathered exception add an entry to PRE_EXISTING_BODY_ACCESS in scripts/check-architecture.mjs.`,
        file,
      )
    } else if (actual > stored) {
      fail(
        'enclave-body-only',
        `${rel} has ${actual} protected-body field access(es), up from the grandfathered ${stored} — new direct _iv/_data/_cek/_det/_sealed access outside kernel/enclave/** is not allowed. Go through the enclave barrel helpers instead of adding to the grandfathered count.`,
        file,
      )
    } else if (actual < stored) {
      fail(
        'enclave-body-only',
        `${rel} has ${actual} protected-body field access(es), down from the grandfathered ${stored} — count drifted down without being banked. Update PRE_EXISTING_BODY_ACCESS's entry for this file to ${actual} (or remove the entry if it reached 0) to lock in the reduction.`,
        file,
      )
    }
  }
}

// ─── Check 12: enclave-classify-only (M1 — stage-2 identifier ratchet) ──
//
// Stage-2 classified: plaintext/digest/key operations live ONLY in
// kernel/enclave/** (the classify/ folder). Outside it, referencing the
// verify-crypto identifiers — or the vdig salt-domain literal — is a leak
// of enclave interior into service/kernel code. Opaque `_vdig`
// ciphertext-map TRANSIT is explicitly permitted (collection/vault/backup/
// history shuttle blobs; C6 carry-forward copies them verbatim inside the
// codec), which is why `_vdig` is deliberately absent from
// BODY_FIELD_ACCESS_RE above. Like enclave-body-only: stripComments (not
// strings — the salt literal IS a string), *.test.ts and __tests__/**
// exempt. The enclave-conformance kit lives under test-harnesses/ (never
// scanned — walkTsFiles here only walks packages/hub/src).
const CLASSIFY_ENCLAVE_ONLY_RE =
  /\bderiveVdigSlotKey\b|\bpbkdf2VerifyDigest\b|\bctEqualTags\b|\bblindedEqual\b|noydb-classify-vdig/

function checkEnclaveClassifyOnly() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const enclaveDir = join(hubSrc, 'kernel', 'enclave')
  walkTsFiles(hubSrc, (file, content) => {
    if (file.endsWith('.test.ts')) return
    if (relative(ROOT, file).split('/').includes('__tests__')) return
    const insideEnclave = !relative(enclaveDir, file).startsWith('..')
    if (insideEnclave) return
    const code = stripComments(content)
    const m = code.match(CLASSIFY_ENCLAVE_ONLY_RE)
    if (m) {
      fail(
        'enclave-classify-only',
        `${relative(ROOT, file)} references "${m[0]}" — verify-digest crypto identifiers and the ` +
        `'noydb-classify-vdig' salt domain are enclave-interior (M1). Call through the classified ` +
        `strategy seam (via/classified/active.ts dynamic import) or the enclave barrel; ` +
        `opaque _vdig ciphertext transit needs no crypto identifier.`,
        file,
      )
    }
  })
}

// ─── Check 13: enclave-classify-index-only (M1 — slice-2b identifier ratchet) ──
//
// Slice-2b blind-index: the bidx key/salt-derivation and target-computation
// identifiers — plus the index salt-domain literals — live ONLY in
// kernel/enclave/** (the classify/ folder). Outside it, referencing these
// is a leak of enclave interior into service/kernel code. The ONE sanctioned
// exception is via/classified/active.ts, which reaches
// computeBidxTarget exclusively through the dynamic-import strategy seam
// (kernel/enclave/classify/find.js) — that file is allowlisted the same way
// enclave/test files are exempt elsewhere in this script. Opaque `_bidx`
// tag-map TRANSIT is explicitly permitted (codec carry-forward, sealing.ts
// verbatim carry, backup/history plumbing), which is why `_bidx` is
// deliberately absent from BODY_FIELD_ACCESS_RE above. Like
// enclave-classify-only: stripComments (not strings — the salt literals ARE
// strings), *.test.ts and __tests__/** exempt. The enclave-conformance kit
// lives under test-harnesses/ (never scanned — walkTsFiles here only walks
// packages/hub/src).
const CLASSIFY_INDEX_ENCLAVE_ONLY_RE =
  /\bderiveClassifyIndexKey\b|\bderiveClassifyIndexSalt\b|\bmintBidxTag\b|\bcomputeBidxTarget\b|noydb-classify-index-v1|noydb-classify-index-salt-v1/

const CLASSIFY_INDEX_ALLOWLIST = new Set(['packages/hub/src/via/classified/active.ts'])

function checkEnclaveClassifyIndexOnly() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const enclaveDir = join(hubSrc, 'kernel', 'enclave')
  walkTsFiles(hubSrc, (file, content) => {
    if (file.endsWith('.test.ts')) return
    if (relative(ROOT, file).split('/').includes('__tests__')) return
    const insideEnclave = !relative(enclaveDir, file).startsWith('..')
    if (insideEnclave) return
    if (CLASSIFY_INDEX_ALLOWLIST.has(relative(ROOT, file))) return
    const code = stripComments(content)
    const m = code.match(CLASSIFY_INDEX_ENCLAVE_ONLY_RE)
    if (m) {
      fail(
        'enclave-classify-index-only',
        `${relative(ROOT, file)} references "${m[0]}" — blind-index key/salt-derivation and target ` +
        `identifiers, and the 'noydb-classify-index-v1'/'noydb-classify-index-salt-v1' literals, are ` +
        `enclave-interior (M1). Call through the classified strategy seam (via/classified/active.ts ` +
        `dynamic import) or the enclave barrel; opaque _bidx tag-map transit needs no crypto identifier.`,
        file,
      )
    }
  })
}

// ─── Check 14: via-layering (#623 — kernel-spine ↔ src/via/* boundary) ──
//
// The Via port converged money/i18n features out of collection.ts/vault.ts
// into src/via/money/ and src/via/i18n/ — a sibling family to
// with-*, not a with-* service itself, so Check 9 (port-layering) never
// restricted it: its fail predicate only matches `with-*` and `port/`
// targets (see that check's own doc comment). This check closes that gap
// for the kernel-spine → via/ direction, mirroring Check 9's mechanics
// exactly (same spine walk, same per-specifier grandfather semantics):
//
//   no file under packages/hub/src/kernel/** may statically import from
//   src/via/**, EXCEPT the frozen baseline in VIA_SHAPE_ALLOWLIST below.
//   Grandfathered PER IMPORT SPECIFIER, not per file — a listed file
//   adding a NEW via/ import outside its frozen list still fails.
//
// via-compose.ts (#623 Task 9) originally needed a second grandfathered
// entry here — its descriptor-shape classification (`mergeViaFields`)
// imported I18nTextDescriptor/DictKeyDescriptor/StaticDictDescriptor + the
// isX predicates straight from via/i18n/*. Task 11's fix wave routed
// those through the port instead (isI18nTextDescriptor/isDictKeyDescriptor
// moved onto port/with/i18n-strategy.ts beside isStaticDictDescriptor; the
// descriptor types were already port-owned re-exports from Task 8), so
// via-compose.ts now imports zero `via/` specifiers and the allowlist
// below holds exactly the one #626 baseline the original brief specified.
//
// The reverse direction — no file under src/via/* may import
// kernel/enclave/ (crypto should reach features only via ctx, not a direct
// enclave-barrel import) — is enforced separately by Check 15
// (via-enclave-isolation) below.
//
// #629 Task 5 (via-classified move) added a SECOND temporary batch —
// `via/classified/{resolve,guards,write,errors}.js` — while the
// classified binding was DORMANT (no compile entry yet). #629 Task 6 (kernel
// cutover) routed those calls through the Via pipeline/`port/with/` seam
// instead and retired every entry in that batch: the allowlist was back to
// exactly the one #626 baseline.
//
// #650 Task 6 retired that last baseline too: `join.ts` no longer imports
// `via/i18n/core.js` — it calls the sync `presentForJoin` hook the
// `Collection` builds from its own i18n + lookup bindings instead (routed
// through `port/with/lookup-strategy.ts`, never a direct via/ import).
// The allowlist is now EMPTY and MUST STAY EMPTY — do not add a new entry;
// `via-layering-empty.test.ts` proves both that this map is empty AND that
// the guard still fires on a synthetic kernel→via/ import.

const VIA_SHAPE_ALLOWLIST = new Map([])

function checkViaLayering() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const kernelDir = join(hubSrc, 'kernel')

  const spineFiles = []
  walkTsFiles(kernelDir, (file) => spineFiles.push(file))
  for (const file of spineFiles) {
    const rel = relative(ROOT, file)
    const allowedImports = VIA_SHAPE_ALLOWLIST.get(rel)
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const spec of staticImportSpecs(code)) {
      if (!spec.startsWith('.')) continue // only relative imports resolve inside hub/src
      if (allowedImports?.includes(spec)) continue // frozen baseline import — grandfathered
      const target = importTargetRelToHubSrc(file, spec, hubSrc)
      if (/^via\//.test(target)) {
        fail(
          'via-layering',
          `${rel} statically imports feature-layer path "${spec}" — the kernel spine may not reach into src/via/** (the Via port's feature layer). VIA_SHAPE_ALLOWLIST is EMPTY (the #626 baseline it once held was retired by #650 Task 6) — there is no grandfathered import left to match. Route through the Via port (kernel/via/index.ts) instead.`,
          file,
        )
      }
    }
  }
}

// ─── Check 15: via-enclave-isolation (#623 — src/via/* → kernel/enclave/ ban) ──
//
// The reverse direction from Check 14: no file under src/via/**
// (the Via port's feature layer — money, i18n) may statically
// import kernel/enclave/ — crypto should reach a feature only via ctx
// (phase B's ViaCryptoCtx, milestone #28), never a direct enclave-barrel
// import. This is STRICTER than Check 10 (enclave-barrel-only), which only
// bans reaching *past* the barrel; importing the barrel itself
// (kernel/enclave/index.js) from anywhere outside kernel/enclave/** is
// explicitly Check-10-legal. Check 15 additionally bans via/** from
// importing the barrel at all.
//
// VIA_ENCLAVE_ALLOWLIST held one explicit, reviewed grandfather:
// via/i18n/dictionary.ts's DictionaryHandle (encrypt/openEnvelopeJson
// for _dict_* entry envelopes) predated #623 — verified via
// `git show 43765b56^:packages/hub/src/with-shape/i18n/dictionary.ts`, the
// identical import was already there before the #623 arc even started, at
// the file's pre-move path. #629 Task 4 rerouted DictionaryHandle onto the
// `reservedEnvelopes('_dict_')` capability (ViaCryptoCtx, milestone #28),
// retiring the grandfather — the allowlist is now EMPTY. Grandfathered PER
// IMPORT SPECIFIER, same semantics as VIA_SHAPE_ALLOWLIST — do not add new
// entries; every via/** file must stay clean.

const VIA_ENCLAVE_ALLOWLIST = new Map([])

function checkViaEnclaveIsolation() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const viaDir = join(hubSrc, 'via')

  const viaDirs = readdirSync(viaDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist')

  for (const dim of viaDirs) {
    walkTsFiles(join(viaDir, dim.name), (file, content) => {
      const rel = relative(ROOT, file)
      const allowedImports = VIA_ENCLAVE_ALLOWLIST.get(rel)
      const code = stripComments(content)
      for (const spec of staticImportSpecs(code)) {
        if (!spec.startsWith('.')) continue // only relative imports resolve inside hub/src
        if (allowedImports?.includes(spec)) continue // frozen baseline import — grandfathered
        const target = importTargetRelToHubSrc(file, spec, hubSrc)
        if (target.startsWith('kernel/enclave/')) {
          fail(
            'via-enclave-isolation',
            `${rel} statically imports enclave path "${spec}" — src/via/** (the Via port's feature layer) may not reach kernel/enclave/ directly, not even the barrel; crypto should reach a feature only via ctx (phase B's ViaCryptoCtx, milestone #28). VIA_ENCLAVE_ALLOWLIST is EMPTY (the DictionaryHandle baseline it once held was retired by #629 Task 4) — there is no grandfathered import left to match.`,
            file,
          )
        }
      }
    })
  }
}

// ─── Run ───────────────────────────────────────────────────────────────

const startTime = Date.now()

checkPeerDeps()
checkNoCryptoDeps()
checkHubPortable()
checkStoresCiphertextOnly()
checkStrategyOptIns()
checkEveryServiceGated()
checkKernelSurface()
checkNoDebugPlaintextInSource()
checkNoOutboundKlumImport()
checkPortLayering()
checkEnclaveBarrelOnly()
checkEnclaveBodyOnly()
checkEnclaveClassifyOnly()
checkEnclaveClassifyIndexOnly()
checkViaLayering()
checkViaEnclaveIsolation()

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

if (failures.length === 0) {
  console.log(`✓ Architecture invariants OK (${elapsed}s)`)
  process.exit(0)
}

// Group failures by check for readable output.
const byCheck = new Map()
for (const f of failures) {
  if (!byCheck.has(f.check)) byCheck.set(f.check, [])
  byCheck.get(f.check).push(f)
}

console.error(`\n✗ Architecture invariants failed: ${failures.length} violation(s) across ${byCheck.size} check(s)\n`)
for (const [check, items] of byCheck) {
  console.error(`── ${check} (${items.length}) ──`)
  for (const item of items) {
    console.error(`  ${item.where ? item.where + ': ' : ''}${item.message}`)
  }
  console.error('')
}
process.exit(1)
