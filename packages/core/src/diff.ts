/**
 * Zero-dependency JSON diff.
 * Produces a flat list of changes between two plain objects.
 */

export type ChangeType = 'added' | 'removed' | 'changed'

export interface DiffEntry {
  /** Dot-separated path to the changed field (e.g. "address.city"). */
  readonly path: string
  /** Type of change. */
  readonly type: ChangeType
  /** Previous value (undefined for 'added'). */
  readonly from?: unknown
  /** New value (undefined for 'removed'). */
  readonly to?: unknown
}

/**
 * Compute differences between two objects.
 * Returns an array of DiffEntry describing each changed field.
 * Returns empty array if objects are identical.
 */
export function diff(oldObj: unknown, newObj: unknown, basePath = ''): DiffEntry[] {
  const changes: DiffEntry[] = []

  // Both primitives or nulls
  if (oldObj === newObj) return changes

  // One is null/undefined
  if (oldObj == null && newObj != null) {
    return [{ path: basePath || '(root)', type: 'added', to: newObj }]
  }
  if (oldObj != null && newObj == null) {
    return [{ path: basePath || '(root)', type: 'removed', from: oldObj }]
  }

  // Different types
  if (typeof oldObj !== typeof newObj) {
    return [{ path: basePath || '(root)', type: 'changed', from: oldObj, to: newObj }]
  }

  // Both primitives (and not equal — checked above)
  if (typeof oldObj !== 'object') {
    return [{ path: basePath || '(root)', type: 'changed', from: oldObj, to: newObj }]
  }

  // Both arrays
  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    const maxLen = Math.max(oldObj.length, newObj.length)
    for (let i = 0; i < maxLen; i++) {
      const p = basePath ? `${basePath}[${i}]` : `[${i}]`
      if (i >= oldObj.length) {
        changes.push({ path: p, type: 'added', to: newObj[i] })
      } else if (i >= newObj.length) {
        changes.push({ path: p, type: 'removed', from: oldObj[i] })
      } else {
        changes.push(...diff(oldObj[i], newObj[i], p))
      }
    }
    return changes
  }

  // Both objects
  const oldRecord = oldObj as Record<string, unknown>
  const newRecord = newObj as Record<string, unknown>
  const allKeys = new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])

  for (const key of allKeys) {
    const p = basePath ? `${basePath}.${key}` : key
    if (!(key in oldRecord)) {
      changes.push({ path: p, type: 'added', to: newRecord[key] })
    } else if (!(key in newRecord)) {
      changes.push({ path: p, type: 'removed', from: oldRecord[key] })
    } else {
      changes.push(...diff(oldRecord[key], newRecord[key], p))
    }
  }

  return changes
}

/** Format a diff as a human-readable string. */
export function formatDiff(changes: DiffEntry[]): string {
  if (changes.length === 0) return '(no changes)'
  return changes.map(c => {
    switch (c.type) {
      case 'added':
        return `+ ${c.path}: ${JSON.stringify(c.to)}`
      case 'removed':
        return `- ${c.path}: ${JSON.stringify(c.from)}`
      case 'changed':
        return `~ ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`
    }
  }).join('\n')
}
