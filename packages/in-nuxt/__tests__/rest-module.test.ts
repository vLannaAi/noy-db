import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured: {
  serverHandlers: Array<{ route: string; handler: string }>
  imports: Array<{ name: string; from: string }>
  plugins: Array<{ src: string; mode?: string }>
  runtimeConfig: Record<string, unknown>
  resolverBase: string | URL | null
  defineNuxtModuleArg: unknown
} = {
  serverHandlers: [],
  imports: [],
  plugins: [],
  runtimeConfig: {},
  resolverBase: null,
  defineNuxtModuleArg: null,
}

vi.mock('@nuxt/kit', () => {
  return {
    defineNuxtModule(definition: {
      meta: { name: string; configKey: string }
      defaults?: Record<string, unknown>
      setup: (options: Record<string, unknown>, nuxt: unknown) => void | Promise<void>
    }) {
      captured.defineNuxtModuleArg = definition
      const moduleFn = async (inlineOptions: Record<string, unknown>, nuxt: unknown) => {
        const merged = { ...(definition.defaults ?? {}), ...inlineOptions }
        return definition.setup(merged, nuxt)
      }
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
    addServerHandler(handler: { route: string; handler: string }) {
      captured.serverHandlers.push(handler)
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

function makeNuxtMock() {
  return {
    options: {
      runtimeConfig: {
        public: {} as Record<string, unknown>,
      },
    },
  }
}

describe('in-nuxt REST module option', () => {
  beforeEach(() => {
    captured.serverHandlers.length = 0
  })

  it('does NOT register a server handler when rest is omitted', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)({}, nuxt)
    expect(captured.serverHandlers).toHaveLength(0)
  })

  it('does NOT register a server handler when rest.enabled is false', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: false } },
      nuxt,
    )
    expect(captured.serverHandlers).toHaveLength(0)
  })

  it('registers a catch-all server handler at the default basePath when rest.enabled is true', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true } },
      nuxt,
    )
    expect(captured.serverHandlers).toHaveLength(1)
    expect(captured.serverHandlers[0]!.route).toBe('/api/noydb/**')
    expect(captured.serverHandlers[0]!.handler).toContain('rest')
  })

  it('uses a custom basePath when provided', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true, basePath: '/rpc' } },
      nuxt,
    )
    expect(captured.serverHandlers[0]!.route).toBe('/rpc/**')
  })

  it('populates runtimeConfig.public.noydb.rest when rest.enabled is true', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true, ttlSeconds: 1800, user: 'api' } },
      nuxt,
    )
    const rc = nuxt.options.runtimeConfig.public as Record<string, Record<string, unknown>>
    expect(rc['noydb']?.['rest']).toMatchObject({ enabled: true, ttlSeconds: 1800, user: 'api' })
  })
})
