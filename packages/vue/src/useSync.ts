import { ref, onUnmounted, type Ref } from 'vue'
import type { Noydb, SyncStatus, PushResult, PullResult } from '@noy-db/core'

export interface UseSyncReturn {
  /** Reactive sync status. */
  status: Ref<SyncStatus>
  /** Whether a sync operation is in progress. */
  syncing: Ref<boolean>
  /** Push local changes to remote. */
  push: () => Promise<PushResult>
  /** Pull remote changes to local. */
  pull: () => Promise<PullResult>
  /** Bidirectional sync (pull then push). */
  sync: () => Promise<void>
}

/**
 * Composable for reactive sync status and controls.
 */
export function useSync(db: Noydb, compartmentName: string): UseSyncReturn {
  const status = ref<SyncStatus>({
    dirty: 0,
    lastPush: null,
    lastPull: null,
    online: true,
  }) as Ref<SyncStatus>
  const syncing = ref(false)

  function refreshStatus(): void {
    status.value = db.syncStatus(compartmentName)
  }

  // Listen for sync events to auto-refresh status
  const onPush = () => refreshStatus()
  const onPull = () => refreshStatus()
  db.on('sync:push', onPush)
  db.on('sync:pull', onPull)

  onUnmounted(() => {
    db.off('sync:push', onPush)
    db.off('sync:pull', onPull)
  })

  async function push(): Promise<PushResult> {
    syncing.value = true
    try {
      const result = await db.push(compartmentName)
      refreshStatus()
      return result
    } finally {
      syncing.value = false
    }
  }

  async function pull(): Promise<PullResult> {
    syncing.value = true
    try {
      const result = await db.pull(compartmentName)
      refreshStatus()
      return result
    } finally {
      syncing.value = false
    }
  }

  async function sync(): Promise<void> {
    syncing.value = true
    try {
      await db.sync(compartmentName)
      refreshStatus()
    } finally {
      syncing.value = false
    }
  }

  // Initial status
  refreshStatus()

  return { status, syncing, push, pull, sync }
}
