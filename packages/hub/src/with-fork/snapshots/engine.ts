import { writePod, readPod } from '../../with-pod/bundle.js'
import { SnapshotNotFoundError } from '../../kernel/errors.js'
import type { NoydbPodStore } from '../../kernel/types.js'
import type { Vault } from '../../kernel/vault.js'
import type { SnapshotMeta, RetentionPolicy, SnapshotIndex } from './strategy.js'

export class SnapshotEngine {
  constructor(
    private readonly store: NoydbPodStore,
    private readonly retention: RetentionPolicy,
  ) {}

  private indexKey(vaultName: string): string {
    return `${vaultName}__index`
  }

  private snapKey(vaultName: string, n: number): string {
    return `${vaultName}__snap_${n.toString().padStart(6, '0')}`
  }

  private autoKey(vaultName: string): string {
    return `${vaultName}__auto`
  }

  private async readIndex(
    vaultName: string,
  ): Promise<{ index: SnapshotIndex; indexVersion: string | null }> {
    const result = await this.store.readBundle(this.indexKey(vaultName))
    if (!result) return { index: { snapshots: [], nextCounter: 1 }, indexVersion: null }
    const text = new TextDecoder().decode(result.bytes)
    return { index: JSON.parse(text) as SnapshotIndex, indexVersion: result.version }
  }

  private async writeIndex(
    vaultName: string,
    index: SnapshotIndex,
    expectedVersion: string | null,
  ): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(index))
    await this.store.writeBundle(this.indexKey(vaultName), bytes, expectedVersion)
  }

  async snapshot(
    vault: Vault,
    by: string,
    opts?: { label?: string; note?: string },
  ): Promise<SnapshotMeta> {
    const bytes = await writePod(vault, {})
    const { index, indexVersion } = await this.readIndex(vault.name)
    const key = this.snapKey(vault.name, index.nextCounter)

    // Write blob first. If the subsequent index write fails, the next snapshot()
    // call will re-derive the same key (counter not persisted) and overwrite this blob.
    // This is an accepted v1 trade-off: failure window is narrow and requires a store
    // error between the two writes. A retry produces a fresh snapshot at the same key.
    await this.store.writeBundle(key, bytes, null)

    const meta: SnapshotMeta = {
      version: key,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
      ...(opts?.note !== undefined ? { note: opts.note } : {}),
      exportedAt: new Date().toISOString(),
      exportedBy: by,
      size: bytes.length,
      integrity: 'verified',
    }

    const newIndex: SnapshotIndex = {
      snapshots: [...index.snapshots, meta],
      nextCounter: index.nextCounter + 1,
      // Preserve the rolling auto slot — on-demand snapshots never touch it.
      ...(index.auto ? { auto: index.auto } : {}),
    }
    const toDelete = this.applyRetention(newIndex)
    await this.writeIndex(vault.name, newIndex, indexVersion)

    for (const k of toDelete) {
      await this.store.deleteBundle(k)
    }

    return meta
  }

  /**
   * Rolling auto-snapshot. Overwrites the single fixed `<vault>__auto` key and
   * stores its meta in `index.auto`, separate from the immutable `snapshots`
   * pool — retention never prunes it. Used by the cadence scheduler.
   */
  async autoSnapshot(
    vault: Vault,
    by: string,
    opts?: { label?: string; note?: string },
  ): Promise<SnapshotMeta> {
    const bytes = await writePod(vault, {})
    const { index, indexVersion } = await this.readIndex(vault.name)
    const key = this.autoKey(vault.name)

    // Unconditional overwrite of the rolling slot.
    await this.store.writeBundle(key, bytes, null)

    const meta: SnapshotMeta = {
      version: key,
      label: opts?.label ?? 'auto',
      ...(opts?.note !== undefined ? { note: opts.note } : {}),
      exportedAt: new Date().toISOString(),
      exportedBy: by,
      size: bytes.length,
      integrity: 'verified',
      auto: true,
    }

    index.auto = meta
    await this.writeIndex(vault.name, index, indexVersion)
    return meta
  }

  async listSnapshots(vaultId: string): Promise<SnapshotMeta[]> {
    const { index } = await this.readIndex(vaultId)
    const immutable = [...index.snapshots].reverse()
    return index.auto ? [index.auto, ...immutable] : immutable
  }

  async restoreSnapshot(vault: Vault, version: string): Promise<void> {
    if (!version.startsWith(`${vault.name}__`)) throw new SnapshotNotFoundError(version)
    const result = await this.store.readBundle(version)
    if (!result) throw new SnapshotNotFoundError(version)
    const { dumpJson } = await readPod(result.bytes)
    await vault.load(dumpJson)
  }

  /**
   * Applies the configured retention policy to `index`, mutating `index.snapshots`
   * in place and returning the blob keys that should be deleted from the store.
   * Called by `snapshot()` before the index is written.
   *
   * @internal — public for direct testing only
   */
  applyRetention(index: SnapshotIndex): string[] {
    const prune = this.retention.prune ?? true
    if (!prune) return []

    const toDelete: string[] = []
    let remaining = index.snapshots.slice()

    if (this.retention.keepLast !== undefined && remaining.length > this.retention.keepLast) {
      const excess = remaining.splice(0, remaining.length - this.retention.keepLast)
      toDelete.push(...excess.map(m => m.version))
    }

    if (this.retention.maxAgeDays !== undefined) {
      const cutoffMs = this.retention.maxAgeDays * 86_400_000
      const now = Date.now()
      const fresh = remaining.filter(m => now - new Date(m.exportedAt).getTime() <= cutoffMs)
      toDelete.push(...remaining.filter(m => !fresh.includes(m)).map(m => m.version))
      remaining = fresh
    }

    index.snapshots = remaining
    return toDelete
  }
}
