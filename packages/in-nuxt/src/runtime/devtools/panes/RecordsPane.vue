<template>
  <div class="noydb-records">
    <div class="noydb-records__header">
      <template v-if="page">
        rows
        <strong>{{ page.total === 0 ? 0 : page.offset + 1 }}–{{ Math.min(page.offset + page.limit, page.total) }}</strong>
        of <strong>{{ page.total }}</strong>
      </template>
      <span v-else-if="error" class="noydb-records__error">{{ error }}</span>
      <span v-else class="noydb-records__loading">loading…</span>
      <div class="noydb-records__nav">
        <button :disabled="!canPrev" @click="$emit('prev')">◀ prev</button>
        <button :disabled="!canNext" @click="$emit('next')">next ▶</button>
      </div>
      <button
        v-if="hasSensitiveFields"
        class="noydb-records__reveal-all"
        data-reveal-all
        @click="revealAll = !revealAll"
      >{{ revealAll ? 'hide all' : 'reveal all' }}</button>
    </div>
    <template v-if="page && fields.length > 0">
      <div class="noydb-records__cols">
        <span v-for="f in fields" :key="f">{{ f }}</span>
      </div>
      <div v-if="page.rows.length === 0" class="noydb-records__empty">No records</div>
      <div v-for="(row, i) in page.rows" :key="i" class="noydb-records__row">
        <span v-for="f in fields" :key="f">
          <template v-if="isVisible(f)">{{ cell(row, f) }}</template>
          <button
            v-else
            class="noydb-records__mask"
            :data-reveal="f"
            @click="reveal(f)"
          >••••••</button>
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { InspectorCollection, RecordPage } from '@noy-db/in-devtools'

const props = defineProps<{
  collection: InspectorCollection
  page: RecordPage | null
  error: string | undefined
}>()

defineEmits<{ prev: []; next: [] }>()

const fields = computed(() => Object.keys(props.collection.fields))

const canPrev = computed(() => !!props.page && props.page.offset > 0)
const canNext = computed(() => !!props.page && props.page.offset + props.page.limit < props.page.total)

// ── PII masking ────────────────────────────────────────────────────────────

/** Set of field keys that are sensitive (pii or secret) per collection.described. */
const sensitiveFields = computed((): Set<string> => {
  const described = props.collection.described
  if (!described) return new Set()
  const s = new Set<string>()
  for (const d of described) {
    if (d.sensitivity !== undefined && d.sensitivity !== 'public') {
      s.add(d.key)
    }
  }
  return s
})

const hasSensitiveFields = computed(() => sensitiveFields.value.size > 0)

/** Tracks which individual fields the user has revealed. */
const revealed = ref(new Set<string>())

/** When true, all sensitive fields are shown. */
const revealAll = ref(false)

function isVisible(field: string): boolean {
  if (!sensitiveFields.value.has(field)) return true
  if (revealAll.value) return true
  return revealed.value.has(field)
}

function reveal(field: string): void {
  revealed.value = new Set([...revealed.value, field])
}

function cell(row: unknown, field: string): string {
  if (row === null || row === undefined || typeof row !== 'object') return '·'
  const val = (row as Record<string, unknown>)[field]
  if (val === null || val === undefined) return '·'
  if (typeof val === 'object') return Array.isArray(val) ? `[${(val as unknown[]).length}]` : '{…}'
  return String(val)
}
</script>
