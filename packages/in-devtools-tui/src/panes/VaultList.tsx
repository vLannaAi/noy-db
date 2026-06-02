import React from 'react'
import { Box, Text } from 'ink'
import type { VaultInfo } from '@noy-db/in-devtools'

export function VaultList({ vaults, activeName }: { vaults: ReadonlyArray<VaultInfo>; activeName: string }) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Vaults</Text>
      {vaults.map((v) => (
        v.id === activeName
          ? <Text key={v.id} color="green">{'› '}{v.id}</Text>
          : <Text key={v.id}>{'  '}{v.id}</Text>
      ))}
    </Box>
  )
}
