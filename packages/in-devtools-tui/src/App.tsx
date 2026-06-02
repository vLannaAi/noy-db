import React, { useState, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { AppProps, DetailTab } from './types.js'
import type { RecordPage } from '@noy-db/in-devtools'
import { VaultList } from './panes/VaultList.js'
import { CollectionList } from './panes/CollectionList.js'
import { DetailPane } from './panes/DetailPane.js'
import { RecordsPane } from './panes/RecordsPane.js'

const PAGE = 20

export function App({ inspector, vault, vaultName, initial }: AppProps) {
  const { exit } = useApp()
  const vaults = initial?.vaults ?? []
  const snapshot = initial?.snapshot
  const collections = snapshot?.collections ?? []
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [drilled, setDrilled] = useState(false)
  const [tab, setTab] = useState<DetailTab>('schema')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<RecordPage | null>(null)
  const [recErr, setRecErr] = useState<string | undefined>(undefined)
  const current = collections[selectedIdx]

  useEffect(() => {
    if (!drilled || tab !== 'records' || !current) return
    let live = true
    setPage(null); setRecErr(undefined)
    inspector.records(vault, current.name, { limit: PAGE, offset })
      .then((p) => { if (live) setPage(p) })
      .catch((e) => { if (live) setRecErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [drilled, tab, current, offset, inspector, vault])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (!drilled) {
      if (key.downArrow) setSelectedIdx((i) => Math.min(collections.length - 1, i + 1))
      if (key.upArrow) setSelectedIdx((i) => Math.max(0, i - 1))
      if (key.return) { setDrilled(true); setTab('schema') }
      return
    }
    if (key.escape) { setDrilled(false); setTab('schema'); setOffset(0) }
    if (key.tab) { setTab((t) => (t === 'schema' ? 'records' : 'schema')); setOffset(0) }
    if (tab === 'records' && page) {
      if (input === 'n' && offset + PAGE < page.total) setOffset((o) => o + PAGE)
      if (input === 'p' && offset - PAGE >= 0) setOffset((o) => o - PAGE)
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>noy-db inspector — {vaultName} <Text dimColor>(↑/↓ · ↵ drill · ⇥ tab · q quit)</Text></Text>
      <Box marginTop={1}>
        <VaultList vaults={vaults} activeName={vaultName} />
        <CollectionList snapshot={snapshot ?? { vault: vaultName, collections: [] }} selectedIdx={selectedIdx} />
        {drilled && tab === 'records' && current
          ? <RecordsPane collection={current} page={page} {...(recErr !== undefined ? { error: recErr } : {})} />
          : <DetailPane collection={drilled ? current : undefined} />}
      </Box>
    </Box>
  )
}
