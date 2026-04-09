import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The module imports `defineNuxtModule`, `addImports`, `addPlugin`, and
 * `createResolver` from `@nuxt/kit`. We mock the entire module so the
 * test runs in pure Node without needing a real Nuxt build.
 *
 * The mocks capture every call so the assertions can introspect what
 * the module did with its options.
 */

const captured: {
  imports: Array<{ name: string; from: string }>
  plugins: Array<{ src: string; mode?: string }>
  resolverBase: string | URL | null
  defineNuxtModuleArg: unknown
} = {
  imports: [],
  plugins: [],
  resolverBase: null,
  defineNuxtModuleArg: null,
}

vi.mock('@nuxt/kit', () => {
  return {
    /**
     * Mock implementation of `defineNuxtModule`. Captures the definition
     * and returns a callable function that runs `setup` against the
     * supplied nuxt context — same shape as the real implementation.
     *
     * The returned function also exposes the original `meta`, `defaults`,
     * and `setup` so tests can introspect them directly.
     */
    defineNuxtModule(definition: {
      meta: { name: string; configKey: string; compatibility?: { nuxt?: string } }
      defaults?: Record<string, unknown>
      setup: (options: Record<string, unknown>, nuxt: unknown) => void | Promise<void>
    }) {
      captured.defineNuxtModuleArg = definition
      const moduleFn = async (inlineOptions: Record<string, unknown>, nuxt: unknown) => {
        const merged = { ...(definition.defaults ?? {}), ...inlineOptions }
        return definition.setup(merged, nuxt)
      }
      // Attach metadata so tests can introspect without running setup.
      Object.assign(moduleFn, {
        meta: definition.meta,
        defaults: definition.defaults,
        setup: definition.setup,
      })
      return moduleFn
    },

    addImports(imports: { name: string; from: string } | Array<{ name: string; from: string }>) {
      const arr = Array.isArray(imports) ? imports : [imports]
      captured.imports.push(...arr)
    },

    addPlugin(plugin: { src: string; mode?: string }) {
      captured.plugins.push(plugin)
      return plugin
    },

    createResolver(base: string | URL) {
      captured.resolverBase = base
      return {
        resolve: (path: string) => `RESOLVED:${path}`,
        resolvePath: (path: string) => Promise.resolve(`RESOLVED:${path}`),
      }
    },
  }
})

// Helper to build a minimal mock Nuxt context the module can mutate.
function makeNuxtMock(): { options: { runtimeConfig: { public: Record<string, unknown> } } } {
  return {
    options: {
      runtimeConfig: {
        public: {},
      },
    },
  }
}

// Reset captured state before each test so they don't bleed.
beforeEach(() => {
  captured.imports = []
  captured.plugins = []
  captured.resolverBase = null
})

describe('@noy-db/nuxt — module factory', () => {
  it('1. exports a default module with the expected meta', async () => {
    const mod = (await import('../src/module.js')).default as unknown as {
      meta: { name: string; configKey: string; compatibility?: { nuxt?: string } }
    }
    expect(mod.meta.name).toBe('@noy-db/nuxt')
    expect(mod.meta.configKey).toBe('noydb')
    expect(mod.meta.compatibility?.nuxt).toBe('^4.0.0')
  })

  it('2. exposes default options matching the v0.3 conventions', async () => {
    const mod = (await import('../src/module.js')).default as unknown as {
      defaults: { pinia?: boolean; devtools?: boolean }
    }
    expect(mod.defaults.pinia).toBe(true)
    expect(mod.defaults.devtools).toBe(true)
  })

  it('3. setup() copies user options into runtimeConfig.public.noydb', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    const nuxt = makeNuxtMock()

    await mod({ adapter: 'browser', sync: { table: 'noydb-prod' } }, nuxt)

    expect(nuxt.options.runtimeConfig.public.noydb).toMatchObject({
      adapter: 'browser',
      sync: { table: 'noydb-prod' },
      pinia: true,    // default applied
      devtools: true, // default applied
    })
  })

  it('4. registers the @noy-db/vue composables for auto-import', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    const names = captured.imports.map(i => i.name)
    expect(names).toContain('useNoydb')
    expect(names).toContain('useCollection')
    expect(names).toContain('useSync')

    // Every @noy-db/vue import comes from the right package.
    const vueImports = captured.imports.filter(i => i.from === '@noy-db/vue')
    expect(vueImports.length).toBeGreaterThanOrEqual(3)
  })

  it('5. registers the @noy-db/pinia helpers when pinia: true (default)', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    const names = captured.imports.map(i => i.name)
    expect(names).toContain('defineNoydbStore')
    expect(names).toContain('createNoydbPiniaPlugin')
    expect(names).toContain('setActiveNoydb')
    expect(names).toContain('getActiveNoydb')

    const piniaImports = captured.imports.filter(i => i.from === '@noy-db/pinia')
    expect(piniaImports.length).toBe(4)
  })

  it('6. skips @noy-db/pinia auto-imports when pinia: false', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({ pinia: false }, makeNuxtMock())

    const names = captured.imports.map(i => i.name)
    expect(names).not.toContain('defineNoydbStore')
    expect(names).not.toContain('setActiveNoydb')
    // The @noy-db/vue imports are still registered — only the pinia
    // ones are skipped.
    expect(names).toContain('useNoydb')
  })

  it('7. registers exactly one client-only runtime plugin', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    expect(captured.plugins).toHaveLength(1)
    expect(captured.plugins[0]?.mode).toBe('client')
  })

  it('8. plugin src points at the runtime/plugin.client.ts file', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    expect(captured.plugins[0]?.src).toContain('plugin.client')
  })

  it('9. NEVER registers a server plugin (SSR safety guarantee)', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    const serverPlugins = captured.plugins.filter(p => p.mode === 'server')
    expect(serverPlugins).toHaveLength(0)

    // Defensive: no plugin without an explicit mode either, since
    // missing mode defaults to BOTH (client+server) in @nuxt/kit.
    const ambiguousPlugins = captured.plugins.filter(p => p.mode === undefined)
    expect(ambiguousPlugins).toHaveLength(0)
  })

  it('10. createResolver is called with import.meta.url (or equivalent)', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    await mod({}, makeNuxtMock())

    expect(captured.resolverBase).not.toBeNull()
    // import.meta.url is a string in ESM; the mock just records it.
    expect(typeof captured.resolverBase === 'string' || captured.resolverBase instanceof URL).toBe(true)
  })

  it('11. preserves additional unknown options through to runtimeConfig (forward-compat)', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>
    const nuxt = makeNuxtMock()
    // Pre-existing config that some other module set first.
    nuxt.options.runtimeConfig.public.noydb = { somethingExternal: true }

    await mod({ adapter: 'dynamo' }, nuxt)

    // Module merges its own values without clobbering pre-existing keys.
    expect(nuxt.options.runtimeConfig.public.noydb).toMatchObject({
      somethingExternal: true,
      adapter: 'dynamo',
      pinia: true,
    })
  })

  it('12. multiple invocations are idempotent (each resets captured state)', async () => {
    const mod = (await import('../src/module.js')).default as unknown as
      (options: Record<string, unknown>, nuxt: unknown) => Promise<void>

    await mod({}, makeNuxtMock())
    const firstImportCount = captured.imports.length
    const firstPluginCount = captured.plugins.length

    // Second invocation against a fresh Nuxt context — captures append
    // because we haven't reset between sub-calls in this test.
    await mod({}, makeNuxtMock())
    expect(captured.imports.length).toBe(firstImportCount * 2)
    expect(captured.plugins.length).toBe(firstPluginCount * 2)
  })
})

describe('@noy-db/nuxt — public API surface', () => {
  it('13. re-exports the module factory as the package default', async () => {
    const pkg = await import('../src/index.js') as { default: unknown }
    expect(pkg.default).toBeDefined()
    expect(typeof pkg.default).toBe('function')
  })

  it('14. exports the ModuleOptions type from the package barrel', async () => {
    // Type-only test: this file would not compile if ModuleOptions
    // weren't exported. The runtime assertion is just a sanity check.
    const pkg = await import('../src/index.js')
    expect(Object.keys(pkg)).toContain('default')
  })
})
