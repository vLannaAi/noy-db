import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorSnapshot } from '@noy-db/in-devtools'

export function CollectionList({ snapshot, selectedIdx }: { snapshot: InspectorSnapshot; selectedIdx: number }) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Collections</Text>
      {snapshot.collections.map((c, i) => (
        i === selectedIdx
          ? <Text key={c.name} color="cyan" inverse>{c.name}</Text>
          : <Text key={c.name}>{c.name}</Text>
      ))}
    </Box>
  )
}
