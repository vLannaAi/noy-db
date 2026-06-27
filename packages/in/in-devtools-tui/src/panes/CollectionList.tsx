import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorSnapshot } from '@noy-db/in-devtools'

export function CollectionList({ snapshot, selectedIdx }: { snapshot: InspectorSnapshot; selectedIdx: number }) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Collections</Text>
      {snapshot.collections.map((c, i) => {
        // Show meta.label when present; append the collection key in dimmed parens
        const display = c.meta?.label ? `${c.meta.label} (${c.name})` : c.name
        return i === selectedIdx
          ? <Text key={c.name} color="cyan" inverse>{display}</Text>
          : <Text key={c.name}>{display}</Text>
      })}
    </Box>
  )
}
