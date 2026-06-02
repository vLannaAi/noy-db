import React from 'react'
import { Box, Text } from 'ink'
import type { FeedRow } from '../types.js'

export function WriteMonitor({ vaultName, rows }: { vaultName: string; rows: ReadonlyArray<FeedRow> }) {
  return (
    <Box flexDirection="column">
      <Text bold>Write Monitor — {vaultName} <Text dimColor>(w/esc · c clear · q quit)</Text></Text>
      <Text dimColor>time      user    op   collection/docId    v</Text>
      {rows.length === 0 && <Text dimColor>(waiting for writes…)</Text>}
      {rows.map((r, i) => (
        r.conflict
          ? <Text key={i} color="yellow">{r.time}  {r.user.padEnd(6)}  {r.op}  {r.target.padEnd(18)} {r.versions}  ⚠ CONFLICT</Text>
          : <Text key={i}>{r.time}  {r.user.padEnd(6)}  {r.op}  {r.target.padEnd(18)} {r.versions}</Text>
      ))}
    </Box>
  )
}
