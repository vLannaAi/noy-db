/**
 * Detect whether the wizard is being invoked inside an existing
 * Nuxt 4 project that should be augmented in place, vs a blank
 * directory where the wizard should create a fresh starter.
 *
 * The detection rule is intentionally narrow so we don't trip on
 * random `package.json` files sitting in the parent tree: a project
 * counts as "existing Nuxt 4" only when the SAME directory has
 * BOTH `nuxt.config.ts` (or `.js`) AND a `package.json` that lists
 * `nuxt` in any of the dependency sections. Either alone is
 * ambiguous:
 *
 *   - `nuxt.config.ts` without a package.json could be a stray
 *     template scratch file the user moved here.
 *   - `package.json` with `nuxt` but no config file could be a
 *     half-deleted project or a pnpm workspace root that pulls
 *     nuxt in transitively for docs.
 *
 * Requiring both avoids both false positives.
 *
 * We deliberately do NOT walk upward to find a parent Nuxt project.
 * The user's cwd is load-bearing — if they wanted to augment a
 * parent dir, they should cd there first. Walking up would make
 * "run the wizard to create a fresh app inside my existing
 * monorepo" silently augment the monorepo root instead.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface NuxtDetection {
  /** Whether cwd contains an existing Nuxt 4 project. */
  readonly existing: boolean
  /** Absolute path of the detected config file, if any. */
  readonly configPath: string | null
  /** Absolute path of the detected package.json, if any. */
  readonly packageJsonPath: string | null
  /** Reason strings explaining the detection outcome — useful for diagnostic messages. */
  readonly reasons: readonly string[]
}

/**
 * Inspect `cwd` for an existing Nuxt 4 project. Returns a detailed
 * result object so the caller can both branch on `existing` and
 * surface the specific reasons to the user.
 *
 * Pure in terms of filesystem reads — no writes, no network, no
 * caching. Callers who need cached detection should memoize on
 * their side.
 */
export async function detectNuxtProject(cwd: string): Promise<NuxtDetection> {
  const reasons: string[] = []

  // Step 1: look for a Nuxt config file. Both extensions are
  // valid; Nuxt itself accepts either.
  const configCandidates = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']
  let configPath: string | null = null
  for (const name of configCandidates) {
    const candidate = path.join(cwd, name)
    if (await pathExists(candidate)) {
      configPath = candidate
      reasons.push(`Found ${name}`)
      break
    }
  }
  if (!configPath) {
    reasons.push('No nuxt.config.{ts,js,mjs} in cwd')
    return {
      existing: false,
      configPath: null,
      packageJsonPath: null,
      reasons,
    }
  }

  // Step 2: look for a package.json in the same directory.
  const pkgPath = path.join(cwd, 'package.json')
  if (!(await pathExists(pkgPath))) {
    reasons.push('Config file present but no package.json — ambiguous, skipping')
    return {
      existing: false,
      configPath,
      packageJsonPath: null,
      reasons,
    }
  }

  // Step 3: verify `nuxt` is in one of the dependency sections.
  // We're lenient about WHICH section (dependencies, devDependencies,
  // peerDependencies) because real-world projects put it in all of
  // them depending on the tooling.
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    reasons.push(`package.json is not valid JSON: ${(err as Error).message}`)
    return {
      existing: false,
      configPath,
      packageJsonPath: pkgPath,
      reasons,
    }
  }

  const depSections = ['dependencies', 'devDependencies', 'peerDependencies'] as const
  let nuxtVersion: string | undefined
  for (const section of depSections) {
    const deps = pkg[section]
    if (deps && typeof deps === 'object' && 'nuxt' in deps) {
      nuxtVersion = (deps as Record<string, string>)['nuxt']
      reasons.push(`Found nuxt@${nuxtVersion} in ${section}`)
      break
    }
  }
  if (!nuxtVersion) {
    reasons.push('Config file present, but package.json does not list `nuxt` as a dependency')
    return {
      existing: false,
      configPath,
      packageJsonPath: pkgPath,
      reasons,
    }
  }

  return {
    existing: true,
    configPath,
    packageJsonPath: pkgPath,
    reasons,
  }
}

/** Cheap fs.access wrapper that returns a boolean instead of throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
