import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorCollection } from '@noy-db/in-devtools'

export function DetailPane({ collection }: { collection: InspectorCollection | undefined }) {
  if (!collection) return (
    <Box flexDirection="column"><Text dimColor>Select a collection (↵)</Text></Box>
  )
  const fieldNames = Object.keys(collection.fields)
  return (
    <Box flexDirection="column">
      <Text bold underline>{collection.name}</Text>
      <Text>records: {collection.stats?.records ?? '—'}  bytes: {collection.stats?.bytes ?? '—'}</Text>
      <Text>fields: {fieldNames.length ? fieldNames.join(', ') : '(none)'}</Text>
    </Box>
  )
}
