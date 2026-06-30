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
 *                       in Track A's kernel shrink so subsystems register
 *                       on the SubsystemBus instead of hard-coding into
 *                       these files. See KERNEL_SURFACE_BUDGET.
 *
 * Each check has its own per-package or per-file allow-list when a
 * legitimate exception exists.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
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

// ─── Check 6: kernel-surface ceiling ───────────────────────────────────

// The always-on orchestration files (loaded by every `createNoydb`) must not
// grow back as subsystems are added. Track A moved write-gating subsystems
// (periods, guards) off these files onto the SubsystemBus; this ceiling locks
// that in. Each value is a RATCHET: lower it when a slice shrinks the file;
// raising it requires a conscious, reviewed bump. A subsystem that re-couples
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
  // and record-scoped sealing (#306) build on top in their own subsystems.
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
  // Lowered 4460→4445 (2026-06-13): record-keys subsystem extraction slice 1.
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
  // BM25 ranker engine live in the tree-shakeable src/search/ subsystem.
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
  'packages/hub/src/collection.ts': 5401,
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
  // the two-party withdrawal ceremony to the bundle subsystem (logic lives in
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
  'packages/hub/src/vault.ts': 4410,
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
  'packages/hub/src/noydb.ts': 3085,
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
        `${rel} is ${lines} lines, over its ${ceiling}-line kernel-surface ceiling (+${lines - ceiling}). The always-on kernel must stay lean — move new capability into a subsystem that registers on the SubsystemBus instead of growing this file. If the growth is genuinely core, raise the ceiling in scripts/check-architecture.mjs with justification.`,
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
          `${relative(ROOT, file)} imports from @klum-db. No @noy-db package (hub core OR edge adapter) may depend on the orchestration package — the dependency runs the other way (@klum-db/lobby depends on @noy-db/hub/kernel + edge adapters).`,
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

// ─── Run ───────────────────────────────────────────────────────────────

const startTime = Date.now()

checkPeerDeps()
checkNoCryptoDeps()
checkHubPortable()
checkStoresCiphertextOnly()
checkStrategyOptIns()
checkKernelSurface()
checkNoDebugPlaintextInSource()
checkNoOutboundKlumImport()

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
