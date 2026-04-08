import type { App, InjectionKey } from 'vue'
import type { Noydb } from '@noy-db/core'

export const NoydbKey: InjectionKey<Noydb> = Symbol('noydb')

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
