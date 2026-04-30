<!--
  Import-preview demo for @noy-db/as-json (#302 phase 1, #313).

  The user pastes a JSON document into the textarea, the page runs
  `as-json.fromString(vault, content)` against the live demo vault,
  renders the resulting `VaultDiff` (added / modified / deleted) with
  field-level diffs on modified rows, and offers an "Apply" button
  that calls `plan.apply()` under the selected reconciliation policy.

  Same review-then-confirm shape every consumer would build — the
  page proves the API surface is sufficient without a custom diff
  renderer per consumer.
-->

<script setup lang="ts">
import { fromString, type AsJSONImportPlan, type ImportPolicy } from '@noy-db/as-json'
import { useNuxtApp } from '#app'

const draft = ref<string>(`{
  "invoices": [
    { "id": "i-1", "client": "Globex", "amount": 1200, "status": "paid" },
    { "id": "i-2", "client": "Acme", "amount": 800, "status": "draft" }
  ]
}`)
const policy = ref<ImportPolicy>('merge')
const importer = ref<AsJSONImportPlan | null>(null)
const error = ref<string | null>(null)
const lastApplied = ref<{ added: number; modified: number; deleted: number } | null>(null)

const summary = computed(() => importer.value?.plan.summary ?? null)

async function previewDiff(): Promise<void> {
  error.value = null
  importer.value = null
  try {
    const { $noydb } = useNuxtApp() as unknown as { $noydb: { openVault: (n: string) => Promise<unknown> } }
    const vault = await $noydb.openVault('demo')
    importer.value = await fromString(vault as Parameters<typeof fromString>[0], draft.value, { policy: policy.value })
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function applyPlan(): Promise<void> {
  if (!importer.value) return
  try {
    await importer.value.apply()
    lastApplied.value = {
      added: importer.value.plan.summary.add,
      modified: importer.value.plan.summary.modify,
      deleted: importer.value.plan.summary.delete,
    }
    importer.value = null
    draft.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}
</script>

<template>
  <section>
    <h2>Import preview — <code>@noy-db/as-json</code></h2>
    <p>
      Paste a JSON document (top-level <code>{ collection: records[] }</code> shape).
      Hit <strong>Preview diff</strong> to see what would change vs the live vault.
      Pick a policy, then <strong>Apply</strong> to commit.
    </p>

    <textarea v-model="draft" rows="10" placeholder="{ collection: [ { id, ... } ] }" />

    <div class="controls">
      <label>
        Policy:
        <select v-model="policy">
          <option value="merge">merge — insert + update, never delete</option>
          <option value="replace">replace — full mirror, deletes absent records</option>
          <option value="insert-only">insert-only — only inserts</option>
        </select>
      </label>
      <button type="button" :disabled="!draft.trim()" @click="previewDiff">Preview diff</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="summary" class="diff">
      <div class="counts">
        <span class="add">{{ summary.add }} added</span>
        <span class="mod">{{ summary.modify }} modified</span>
        <span class="del">{{ summary.delete }} deleted</span>
      </div>

      <details v-if="summary.add > 0">
        <summary>Added ({{ summary.add }})</summary>
        <ul>
          <li v-for="e in importer!.plan.added" :key="`${e.collection}/${e.id}`">
            <code>{{ e.collection }}/{{ e.id }}</code>
          </li>
        </ul>
      </details>

      <details v-if="summary.modify > 0">
        <summary>Modified ({{ summary.modify }})</summary>
        <ul>
          <li v-for="e in importer!.plan.modified" :key="`${e.collection}/${e.id}`">
            <code>{{ e.collection }}/{{ e.id }}</code>
            <ul class="fields">
              <li v-for="f in e.fieldDiffs" :key="f.path">
                <code>{{ f.path }}</code>:
                <span class="from">{{ JSON.stringify(f.from) }}</span>
                →
                <span class="to">{{ JSON.stringify(f.to) }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </details>

      <details v-if="summary.delete > 0">
        <summary>Deleted ({{ summary.delete }})</summary>
        <ul>
          <li v-for="e in importer!.plan.deleted" :key="`${e.collection}/${e.id}`">
            <code>{{ e.collection }}/{{ e.id }}</code>
            <em v-if="policy !== 'replace'"> (skipped under {{ policy }} policy)</em>
          </li>
        </ul>
      </details>

      <button type="button" :disabled="summary.total === 0" class="primary" @click="applyPlan">
        Apply ({{ policy }} policy)
      </button>
    </div>

    <p v-if="lastApplied" class="applied">
      Applied: {{ lastApplied.added }} added,
      {{ policy === 'insert-only' ? 0 : lastApplied.modified }} modified,
      {{ policy === 'replace' ? lastApplied.deleted : 0 }} deleted.
    </p>
  </section>
</template>

<style scoped>
section { display: flex; flex-direction: column; gap: 0.75rem; }
h2 { margin: 0; font-size: 1.2rem; }
textarea {
  width: 100%; font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  font-size: 0.85rem; padding: 0.6rem; border: 1px solid #d1d5db; border-radius: 0.25rem;
}
.controls { display: flex; gap: 0.75rem; align-items: center; }
button { background: white; border: 1px solid #2563eb; color: #2563eb; }
button.primary { background: #2563eb; color: white; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error {
  background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b;
  padding: 0.5rem 0.75rem; border-radius: 0.25rem; font-size: 0.875rem;
}
.applied {
  background: #ecfdf5; border: 1px solid #86efac; color: #166534;
  padding: 0.5rem 0.75rem; border-radius: 0.25rem; font-size: 0.875rem;
}
.diff {
  display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem;
  border: 1px solid #e5e7eb; border-radius: 0.25rem; background: white;
}
.counts { display: flex; gap: 1rem; font-weight: 600; }
.counts .add { color: #047857; }
.counts .mod { color: #b45309; }
.counts .del { color: #b91c1c; }
ul { margin: 0.5rem 0; padding-left: 1.5rem; }
ul.fields { margin: 0.25rem 0 0 0; padding-left: 1.5rem; font-size: 0.85rem; }
ul.fields .from { color: #b91c1c; }
ul.fields .to { color: #047857; }
details summary { cursor: pointer; padding: 0.25rem 0; }
code {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  background: #f3f4f6; padding: 0 0.25rem; border-radius: 0.15rem; font-size: 0.85em;
}
</style>
