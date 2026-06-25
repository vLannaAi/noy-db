import React from 'react'
import { Box, Text } from 'ink'
import type { InspectorCollection } from '@noy-db/in-devtools'
import type { CollectionConfig } from '@noy-db/hub'

/** Compact sensitivity marker for terminal rendering. */
function sensitivityTag(s: 'public' | 'pii' | 'secret' | undefined): string {
  if (s === 'pii') return '[pii]'
  if (s === 'secret') return '[secret]'
  return ''
}

/** Render a compact config line from CollectionConfig fields that are set. */
function ConfigLine({ config }: { config: CollectionConfig }) {
  const parts: string[] = []
  if (config.textIndexes?.length) parts.push(`idx:${config.textIndexes.length}`)
  if (config.embeddings) parts.push(`emb:${config.embeddings.dim}d`)
  if (config.i18nFields?.length) parts.push(`i18n:${config.i18nFields.length}`)
  if (config.crdt) parts.push(`crdt:${config.crdt}`)
  if (config.provenance) parts.push('provenance')
  if (config.archive) parts.push('archive')
  if (config.tiers?.length) parts.push(`tiers:${config.tiers.join(',')}`)
  if (config.perRecordKeys) parts.push('per-record-cek')
  if (!parts.length) return null
  return <Text dimColor>config: {parts.join('  ')}</Text>
}

export function DetailPane({ collection }: { collection: InspectorCollection | undefined }) {
  if (!collection) return (
    <Box flexDirection="column"><Text dimColor>Select a collection (↵)</Text></Box>
  )

  const heading = collection.meta?.label
    ? `${collection.meta.label} (${collection.name})`
    : collection.name

  return (
    <Box flexDirection="column">
      <Text bold underline>{heading}</Text>
      {collection.meta?.description
        ? <Text dimColor>{collection.meta.description}</Text>
        : null}
      <Text>records: {collection.stats?.records ?? '—'}  bytes: {collection.stats?.bytes ?? '—'}</Text>

      {/* Rich field list from describe() when available */}
      {collection.described && collection.described.length > 0
        ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>schema</Text>
            {collection.described.map((f) => {
              const sens = sensitivityTag(f.sensitivity)
              const i18nMark = f.i18n ? '[i18n]' : ''
              const roMark = f.editable === false ? '[ro]' : ''
              const widgetMark = f.widget ? `<${f.widget}>` : ''
              const markers = [sens, i18nMark, roMark, widgetMark].filter(Boolean).join(' ')
              return (
                <Text key={f.key}>
                  {'  '}{f.label} <Text dimColor>({f.key}: {f.type})</Text>
                  {markers ? <Text color="yellow">  {markers}</Text> : null}
                </Text>
              )
            })}
          </Box>
        )
        : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>schema</Text>
            {Object.keys(collection.fields).length
              ? Object.keys(collection.fields).map((k) => (
                <Text key={k}>{'  '}{k}: <Text dimColor>{collection.fields[k].type}</Text></Text>
              ))
              : <Text dimColor>  (no declared fields)</Text>}
          </Box>
        )}

      {/* Collection config strip */}
      {collection.config
        ? <Box marginTop={1}><ConfigLine config={collection.config} /></Box>
        : null}
    </Box>
  )
}
