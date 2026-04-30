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

function checkStrategyOptIns() {
  for (const pkgDir of listPackageDirs()) {
    walkTsFiles(join(pkgDir, 'src'), scanFileForStrategyOptIn)
    walkTsFiles(join(pkgDir, '__tests__'), scanFileForStrategyOptIn)
  }
}

function scanFileForStrategyOptIn(file, content) {
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

// ─── Run ───────────────────────────────────────────────────────────────

const startTime = Date.now()

checkPeerDeps()
checkNoCryptoDeps()
checkHubPortable()
checkStoresCiphertextOnly()
checkStrategyOptIns()

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
