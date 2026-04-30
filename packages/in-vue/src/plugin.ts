import type { App, InjectionKey } from 'vue'
import type { Noydb } from '@noy-db/hub'

/**
 * Vue injection key for the NOYDB instance provided by `NoydbPlugin`.
 * Use with `inject(NoydbKey)` inside any component under the plugin's scope.
 */
export const NoydbKey: InjectionKey<Noydb> = Symbol('noydb')

/**
 * Options passed to `app.use(NoydbPlugin, options)` when registering
 * the NOYDB Vue plugin.
 */
export interface NoydbPluginOptions {
  /** The NOYDB instance to provide to all components. */
  instance: Noydb
}

/** Vue plugin that provides a NOYDB instance to all components. */
export const NoydbPlugin = {
  install(app: App, options: NoydbPluginOptions): void {
    app.provide(NoydbKey, options.instance)
  },
}
