<template>
  <aside class="noydb-sidebar">
    <div class="noydb-sidebar__header">Vault</div>
    <template v-if="vaultName">
      <div class="noydb-sidebar__vault">▸ {{ vaultName }}</div>
      <button
        v-for="coll in collections"
        :key="coll.name"
        :class="['noydb-sidebar__item', { 'noydb-sidebar__item--selected': coll.name === selectedName }]"
        @click="$emit('select', coll)"
      >
        <span>{{ coll.name }}</span>
        <span v-if="coll.stats?.count" class="noydb-sidebar__badge">{{ coll.stats.count }}</span>
      </button>
    </template>
    <div v-else class="noydb-sidebar__empty">—</div>
  </aside>
</template>

<script setup lang="ts">
import type { InspectorCollection } from '@noy-db/in-devtools'

defineProps<{
  vaultName: string | null
  collections: ReadonlyArray<InspectorCollection>
  selectedName: string | null
}>()

defineEmits<{ select: [collection: InspectorCollection] }>()
</script>
