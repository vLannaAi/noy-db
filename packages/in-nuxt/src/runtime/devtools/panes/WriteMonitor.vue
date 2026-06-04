<template>
  <div class="noydb-monitor">
    <div v-if="meter" class="noydb-monitor__latency">
      put p50 {{ meter.byMethod?.['put']?.p50 ?? '—' }}ms
      p99 {{ meter.byMethod?.['put']?.p99 ?? '—' }}ms
      · del p50 {{ meter.byMethod?.['delete']?.p50 ?? '—' }}ms
      <span v-if="meter.status === 'degraded'" class="noydb-monitor__degraded"> ⚠ degraded</span>
    </div>
    <div class="noydb-monitor__cols">
      <span>time</span>
      <span>user</span>
      <span>op</span>
      <span>target</span>
      <span>ver</span>
    </div>
    <div v-if="rows.length === 0" class="noydb-monitor__empty">Waiting for writes…</div>
    <div
      v-for="(row, i) in rows"
      :key="i"
      :class="['noydb-monitor__row', { 'noydb-monitor__row--conflict': row.conflict }]"
    >
      <span>{{ row.time }}</span>
      <span>{{ row.user }}</span>
      <span>{{ row.op }}</span>
      <span>{{ row.target }}</span>
      <span>{{ row.versions }}</span>
      <span v-if="row.conflict" class="noydb-monitor__badge">⚠ conflict</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MeterSnapshot } from '@noy-db/to-meter'

export interface FeedRow {
  readonly time: string
  readonly user: string
  readonly op: 'put' | 'del'
  readonly target: string
  readonly versions: string
  readonly baseKey: string
  conflict: boolean
}

defineProps<{
  rows: ReadonlyArray<FeedRow>
  meter: MeterSnapshot | null
}>()
</script>
