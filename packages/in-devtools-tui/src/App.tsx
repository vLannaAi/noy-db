import React, { useState, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { AppProps, DetailTab, View, FeedRow } from './types.js'
import type { RecordPage } from '@noy-db/in-devtools'
import type { InspectorWriteEvent } from '@noy-db/in-devtools'
import type { MeterSnapshot } from '@noy-db/to-meter'
import { VaultList } from './panes/VaultList.js'
import { CollectionList } from './panes/CollectionList.js'
import { DetailPane } from './panes/DetailPane.js'
import { RecordsPane } from './panes/RecordsPane.js'
import { WriteMonitor } from './panes/WriteMonitor.js'

const PAGE = 20
const BUFFER = 200

function fmtTime(ts: number): string { return new Date(ts).toTimeString().slice(0, 8) }

function rowOf(e: InspectorWriteEvent): FeedRow {
  const op = e.op === 'delete' ? 'del' : 'put'
  const versions = e.op === 'delete' ? `${e.baseVersion}→·` : `${e.baseVersion}→${e.version}`
  return { time: fmtTime(e.timestamp), user: e.userId, op, target: `${e.collection}/${e.docId}`, versions, baseKey: `${e.collection}/${e.docId}@${e.baseVersion}`, conflict: false }
}

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

  const [view, setView] = useState<View>('structure')
  const [feed, setFeed] = useState<ReadonlyArray<FeedRow>>([])
  const [started, setStarted] = useState(false)
  const [meter, setMeter] = useState<MeterSnapshot | null>(null)
  useEffect(() => {
    if (view !== 'monitor') return
    const tick = () => setMeter(inspector.meterSnapshot())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [view, inspector])

  useEffect(() => {
    if (!drilled || tab !== 'records' || !current) return
    let live = true
    setPage(null); setRecErr(undefined)
    inspector.records(vault, current.name, { limit: PAGE, offset })
      .then((p) => { if (live) setPage(p) })
      .catch((e) => { if (live) setRecErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [drilled, tab, current, offset, inspector, vault])

  useEffect(() => {
    if (!started) return
    const offW = inspector.subscribe((e) => {
      setFeed((prev) => {
        const row = rowOf(e)
        const overlap = prev.some((r) => r.baseKey === row.baseKey && r.user !== row.user)
        if (overlap) row.conflict = true
        const next = [row, ...prev.map((r) => (r.baseKey === row.baseKey && r.user !== row.user ? { ...r, conflict: true } : r))]
        return next.slice(0, BUFFER)
      })
    })
    const offC = inspector.subscribeConflicts((c) => {
      const key = `${c.collection}/${c.docId}@${c.baseVersion}`
      setFeed((prev) => prev.map((r) => (r.baseKey === key ? { ...r, conflict: true } : r)))
    })
    return () => { offW(); offC() }
  }, [started, inspector])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }
    if (view === 'monitor') {
      if (key.escape) setView('structure')
      if (input === 'c') setFeed([])
      return
    }
    if (input === 'w') { setView('monitor'); setStarted(true); return }
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

  if (view === 'monitor') return <WriteMonitor vaultName={vaultName} rows={feed} meter={meter} />

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
