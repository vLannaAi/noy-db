import React from 'react'
import { Box, Text } from 'ink'
import type { FeedRow } from '../types.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

export function WriteMonitor({ vaultName, rows, meter }: { vaultName: string; rows: ReadonlyArray<FeedRow>; meter: MeterSnapshot | null }) {
  const m = meter?.byMethod
  return (
    <Box flexDirection="column">
      <Text bold>Write Monitor — {vaultName} <Text dimColor>(w/esc · c clear · q quit)</Text></Text>
      {meter && m && (
        <Text>
          store  put p50 {m.put?.p50 ?? '—'}ms p99 {m.put?.p99 ?? '—'}ms{meter.status === 'degraded' ? ' ⚠degraded' : ''} · del p50 {m.delete?.p50 ?? '—'} p99 {m.delete?.p99 ?? '—'} · get p50 {m.get?.p50 ?? '—'} p99 {m.get?.p99 ?? '—'}
        </Text>
      )}
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
