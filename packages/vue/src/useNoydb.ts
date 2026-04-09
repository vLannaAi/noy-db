import { inject } from 'vue'
import type { Noydb } from '@noy-db/core'
import { NoydbKey } from './plugin.js'

/** Composable to access the injected NOYDB instance. */
export function useNoydb(): Noydb {
  const db = inject(NoydbKey)
  if (!db) {
    throw new Error(
      'NOYDB instance not found. Did you install the NoydbPlugin?\n' +
      'Example: app.use(NoydbPlugin, { instance: db })',
    )
  }
  return db
}
