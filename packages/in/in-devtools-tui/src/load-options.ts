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
