<template>
  <div class="noydb-schema">
    <template v-if="collection">
      <!-- Collection meta header -->
      <div class="noydb-schema__meta-header">
        <span class="noydb-schema__meta-label">{{ collectionLabel }}</span>
        <span
          v-if="collection.meta?.description"
          class="noydb-schema__meta-desc"
          :title="collection.meta.description"
        >{{ collection.meta.description }}</span>
      </div>

      <!-- Config strip (badges for active config options) -->
      <div v-if="configBadges.length" class="noydb-schema__config-strip">
        <span
          v-for="badge in configBadges"
          :key="badge"
          class="noydb-schema__config-badge"
        >{{ badge }}</span>
      </div>

      <div class="noydb-schema__label noydb-schema__label--mt">Fields</div>

      <!-- Rich rows from described (when present) -->
      <template v-if="collection.described && collection.described.length">
        <div
          v-for="field in collection.described"
          :key="field.key"
          class="noydb-schema__row"
        >
          <span class="noydb-schema__name">{{ field.label }}</span>
          <span class="noydb-schema__name noydb-schema__name--key" :title="field.key">{{ field.key }}</span>
          <span class="noydb-schema__type">{{ field.type }}</span>
          <span v-if="field.semanticType || field.widget" class="noydb-schema__badge noydb-schema__badge--semantic">
            {{ field.semanticType ?? field.widget }}
          </span>
          <span v-if="field.money?.currency" class="noydb-schema__badge noydb-schema__badge--money">
            {{ field.money.currency }}
          </span>
          <span v-if="field.dict" class="noydb-schema__badge noydb-schema__badge--dict">
            dict{{ field.dict.values ? ` ×${field.dict.values.length}` : '' }}
          </span>
          <span v-if="field.sensitivity === 'pii'" class="noydb-schema__badge noydb-schema__badge--pii">pii</span>
          <span v-if="field.sensitivity === 'secret'" class="noydb-schema__badge noydb-schema__badge--secret">secret</span>
          <span v-if="field.i18n" class="noydb-schema__badge noydb-schema__badge--i18n">i18n</span>
          <span v-if="field.ref" class="noydb-schema__badge noydb-schema__badge--ref" :title="`→ ${field.ref.target}`">
            → {{ field.ref.target }}
          </span>
          <span v-if="!field.editable" class="noydb-schema__badge noydb-schema__badge--readonly">read-only</span>
          <span class="noydb-schema__flag">{{ isIndexed(field.key) ? 'idx' : '' }}</span>
        </div>
      </template>

      <!-- Fallback rows from fields (back-compat) -->
      <template v-else>
        <div
          v-for="[name, field] in fieldEntries"
          :key="name"
          class="noydb-schema__row"
        >
          <span class="noydb-schema__name">{{ name }}</span>
          <span class="noydb-schema__type">{{ (field as { type?: string }).type ?? '—' }}</span>
          <span class="noydb-schema__flag">{{ isIndexed(name) ? 'idx' : '' }}</span>
        </div>
      </template>

      <div class="noydb-schema__label noydb-schema__label--mt">Stats</div>
      <div class="noydb-schema__stat">
        docs <strong>{{ collection.stats?.count ?? '—' }}</strong>
        · size <strong>{{ fmtBytes(collection.stats?.bytes) }}</strong>
        · indexes <strong>{{ collection.indexes?.length ?? 0 }}</strong>
      </div>
    </template>
    <div v-else class="noydb-schema__empty">Select a collection</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { InspectorCollection } from '@noy-db/in-devtools'

const props = defineProps<{ collection: InspectorCollection | null }>()

const collectionLabel = computed(() =>
  props.collection?.meta?.label ?? props.collection?.name ?? ''
)

const fieldEntries = computed(() =>
  props.collection ? Object.entries(props.collection.fields) : []
)

/** Build small text badges for whichever config options are active. */
const configBadges = computed((): string[] => {
  const cfg = props.collection?.config
  if (!cfg) return []
  const badges: string[] = []
  if (cfg.embeddings) badges.push('embeddings')
  if (cfg.textIndexes && cfg.textIndexes.length) badges.push('text-index')
  if (cfg.crdt) badges.push(`crdt:${cfg.crdt}`)
  if (cfg.provenance) badges.push('provenance')
  if (cfg.archive) badges.push('archive')
  if (cfg.tiers && cfg.tiers.length) badges.push(`tiers:${cfg.tiers.length}`)
  if (cfg.perRecordKeys) badges.push('per-record-keys')
  if (cfg.history) badges.push('history')
  if (cfg.schemaUpdate && cfg.schemaUpdate.length) badges.push('schema-update')
  return badges
})

function isIndexed(name: string): boolean {
  return props.collection?.indexes?.some((idx) => {
    const fields = (idx as { fields?: string | string[] }).fields
    if (!fields) return false
    return Array.isArray(fields) ? fields.includes(name) : fields === name
  }) ?? false
}

function fmtBytes(n?: number): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
</script>
