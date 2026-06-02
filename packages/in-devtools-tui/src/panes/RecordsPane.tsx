import React from 'react'
import { Box, Text } from 'ink'
import type { RecordPage, InspectorCollection } from '@noy-db/in-devtools'

function cell(value: unknown): string {
  if (value === null || value === undefined) return '·'
  if (typeof value === 'object') return Array.isArray(value) ? `[${(value as unknown[]).length}]` : '{…}'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return '?'
}

export function RecordsPane({ collection, page, error }: {
  collection: InspectorCollection
  page: RecordPage | null
  error?: string
}) {
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
  return (
    <Box flexDirection="column">
      <Text bold>rows {from}–{to} of {page.total} <Text dimColor>(n/p page · ⇥ back)</Text></Text>
      <Text dimColor>{fields.join('  ')}</Text>
      {page.rows.map((row, i) => (
        <Text key={i}>{fields.map((f) => cell((row as Record<string, unknown>)?.[f])).join('  ')}</Text>
      ))}
    </Box>
  )
}
