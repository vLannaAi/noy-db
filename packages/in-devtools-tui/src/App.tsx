import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { AppProps } from './types.js'
import { VaultList } from './panes/VaultList.js'
import { CollectionList } from './panes/CollectionList.js'
import { DetailPane } from './panes/DetailPane.js'

export function App({ vaultName, initial }: AppProps) {
  const { exit } = useApp()
  const vaults = initial?.vaults ?? []
  const snapshot = initial?.snapshot
  const collections = snapshot?.collections ?? []
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [drilled, setDrilled] = useState(false)

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (key.downArrow) setSelectedIdx((i) => Math.min(collections.length - 1, i + 1))
    if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1))
    if (key.return) setDrilled(true)
    if (key.escape) setDrilled(false)
  })

  return (
    <Box flexDirection="column">
      <Text bold>noy-db inspector — {vaultName} <Text dimColor>(↑/↓ select · ↵ detail · q quit)</Text></Text>
      <Box marginTop={1}>
        <VaultList vaults={vaults} activeName={vaultName} />
        <CollectionList snapshot={snapshot ?? { vault: vaultName, collections: [] }} selectedIdx={selectedIdx} />
        <DetailPane collection={drilled ? collections[selectedIdx] : undefined} />
      </Box>
    </Box>
  )
}
