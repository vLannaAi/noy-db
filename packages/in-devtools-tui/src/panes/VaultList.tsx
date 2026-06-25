import React from 'react'
import { Box, Text } from 'ink'
import type { VaultInfo, InspectorSnapshot } from '@noy-db/in-devtools'

export function VaultList({
  vaults,
  activeName,
  snapshot,
}: {
  vaults: ReadonlyArray<VaultInfo>
  activeName: string
  /** Active vault snapshot; used to read vault meta.label when available. */
  snapshot?: InspectorSnapshot
}) {
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text bold underline>Vaults</Text>
      {vaults.map((v) => {
        // Show meta.label for the active vault when available
        const vaultLabel = v.id === activeName && snapshot?.meta?.label
          ? `${snapshot.meta.label} (${v.id})`
          : v.id
        return v.id === activeName
          ? <Text key={v.id} color="green">{'› '}{vaultLabel}</Text>
          : <Text key={v.id}>{'  '}{v.id}</Text>
      })}
    </Box>
  )
}
