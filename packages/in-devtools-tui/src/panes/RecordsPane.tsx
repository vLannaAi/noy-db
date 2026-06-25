import React from 'react'
import { Box, Text } from 'ink'
import type { RecordPage, InspectorCollection } from '@noy-db/in-devtools'

const MASK = '••••'

function cell(value: unknown): string {
  if (value === null || value === undefined) return '·'
  if (typeof value === 'object') return Array.isArray(value) ? `[${(value as unknown[]).length}]` : '{…}'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return '?'
}

export function RecordsPane({ collection, page, error, revealAll }: {
  collection: InspectorCollection
  page: RecordPage | null
  error?: string
  revealAll?: boolean
}) {
  // Build the set of sensitive field keys from described[] (pii + secret); empty if no described.
  const sensitiveKeys: ReadonlySet<string> = React.useMemo(() => {
    if (!collection.described) return new Set<string>()
    const keys = new Set<string>()
    for (const f of collection.described) {
      if (f.sensitivity !== undefined && f.sensitivity !== 'public') keys.add(f.key)
    }
    return keys
  }, [collection.described])

  const schemaFields = Object.keys(collection.fields)
  if (error) return <Box flexDirection="column"><Text color="red">records error: {error}</Text><Text dimColor>n/p retry · ⇥ back</Text></Box>
  if (!page) return <Box flexDirection="column"><Text dimColor>loading records…</Text></Box>
  // Fall back to first-row keys when schema has no declared fields
  const firstRowKeys = page.rows.length > 0 && typeof page.rows[0] === 'object' && page.rows[0] !== null
    ? Object.keys(page.rows[0] as Record<string, unknown>)
    : []
  const fields = schemaFields.length > 0 ? schemaFields : firstRowKeys
  const from = page.total === 0 ? 0 : page.offset + 1
  const to = Math.min(page.offset + page.limit, page.total)

  function renderCell(f: string, row: unknown): string {
    const raw = cell((row as Record<string, unknown>)?.[f])
    if (!revealAll && sensitiveKeys.has(f)) return MASK
    return raw
  }

  const revealHint = sensitiveKeys.size > 0 ? ' · r reveal' : ''
  return (
    <Box flexDirection="column">
      <Text bold>rows {from}–{to} of {page.total} <Text dimColor>(n/p page · ⇥ back{revealHint})</Text></Text>
      <Text dimColor>{fields.join('  ')}</Text>
      {page.rows.map((row, i) => (
        <Text key={i}>{fields.map((f) => renderCell(f, row)).join('  ')}</Text>
      ))}
    </Box>
  )
}
