<template>
  <div class="noydb-schema">
    <template v-if="collection">
      <div class="noydb-schema__label">Fields</div>
      <div
        v-for="[name, field] in fieldEntries"
        :key="name"
        class="noydb-schema__row"
      >
        <span class="noydb-schema__name">{{ name }}</span>
        <span class="noydb-schema__type">{{ (field as { type?: string }).type ?? '—' }}</span>
        <span class="noydb-schema__flag">{{ isIndexed(name) ? 'idx' : '' }}</span>
      </div>
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

const fieldEntries = computed(() =>
  props.collection ? Object.entries(props.collection.fields) : []
)

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
