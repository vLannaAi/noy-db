<template>
  <div class="noydb-panel">
    <!-- no db bound -->
    <div v-if="!db" class="noydb-panel__empty">
      <p>No active noy-db instance.</p>
      <code>Call setActiveNoydb(db) in your plugin.</code>
    </div>
    <!-- db bound but no vault open -->
    <div v-else-if="initialized && !vaultInfo" class="noydb-panel__empty">
      <p>No open vaults — unlock a vault in your app first.</p>
    </div>
    <!-- loading -->
    <div v-else-if="!initialized" class="noydb-panel__empty">
      <p>Loading…</p>
    </div>
    <!-- main panel -->
    <template v-else>
      <!-- top nav -->
      <nav class="noydb-nav">
        <span class="noydb-nav__logo">noy-db</span>
        <button
          :class="['noydb-nav__tab', { 'noydb-nav__tab--active': topTab === 'structure' }]"
          @click="topTab = 'structure'"
        >Structure</button>
        <button
          :class="['noydb-nav__tab', { 'noydb-nav__tab--active': topTab === 'monitor' }]"
          @click="activateMonitor"
        >Monitor</button>
        <span class="noydb-nav__spacer" />
        <span class="noydb-nav__status">
          <span class="noydb-nav__dot" />{{ vaultInfo!.id }}
        </span>
      </nav>

      <!-- structure tab -->
      <div v-if="topTab === 'structure'" class="noydb-panel__body">
        <VaultSidebar
          :vault-name="vaultInfo!.id"
          :vault-meta="snapshotMeta"
          :collections="collections"
          :selected-name="selectedCollection?.name ?? null"
          @select="selectCollection"
        />
        <div class="noydb-panel__detail">
          <div v-if="snapshotError" class="noydb-panel__error">{{ snapshotError }}</div>
          <template v-else-if="selectedCollection">
            <div class="noydb-detail-tabs">
              <button
                :class="['noydb-detail-tab', { 'noydb-detail-tab--active': detailTab === 'schema' }]"
                @click="detailTab = 'schema'"
              >Schema</button>
              <button
                :class="['noydb-detail-tab', { 'noydb-detail-tab--active': detailTab === 'records' }]"
                @click="detailTab = 'records'"
              >Records</button>
            </div>
            <SchemaPane v-if="detailTab === 'schema'" :collection="selectedCollection" />
            <RecordsPane
              v-else
              :collection="selectedCollection"
              :page="recordsPage"
              :error="recordsError"
              @prev="prevPage"
              @next="nextPage"
            />
          </template>
          <div v-else class="noydb-panel__empty">Select a collection</div>
        </div>
      </div>

      <!-- monitor tab -->
      <WriteMonitor v-else :rows="feed" :meter="meter" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { getActiveNoydb } from '@noy-db/in-pinia'
import { createInspector } from '@noy-db/in-devtools'
import type { Inspector, InspectorCollection, VaultInfo, RecordPage } from '@noy-db/in-devtools'
import type { Vault, VaultMeta } from '@noy-db/hub'
import type { MeterSnapshot } from '@noy-db/to-meter'
import VaultSidebar from './panes/VaultSidebar.vue'
import SchemaPane from './panes/SchemaPane.vue'
import RecordsPane from './panes/RecordsPane.vue'
import WriteMonitor from './panes/WriteMonitor.vue'
import type { FeedRow } from './panes/WriteMonitor.vue'

const PAGE = 20
const BUFFER = 200

// ── Inspector setup ─────────────────────────────────────────────
const db = ref(getActiveNoydb())
const inspector = computed<Inspector | null>(() =>
  db.value ? createInspector(db.value) : null
)

// ── Vault / snapshot state ───────────────────────────────────────
const initialized = ref(false)
const vaults = ref<ReadonlyArray<VaultInfo>>([])
const vaultInfo = computed(() => vaults.value[0] ?? null)
const openVault = ref<Vault | null>(null)
const collections = ref<ReadonlyArray<InspectorCollection>>([])
const snapshotMeta = ref<VaultMeta | null>(null)
const snapshotError = ref<string | undefined>(undefined)
const selectedCollection = ref<InspectorCollection | null>(null)

// ── Detail tab state ─────────────────────────────────────────────
const topTab = ref<'structure' | 'monitor'>('structure')
const detailTab = ref<'schema' | 'records'>('schema')
const recordsOffset = ref(0)
const recordsPage = ref<RecordPage | null>(null)
const recordsError = ref<string | undefined>(undefined)

// ── Monitor state ────────────────────────────────────────────────
const feed = ref<ReadonlyArray<FeedRow>>([])
const meter = ref<MeterSnapshot | null>(null)
const conflictKeys = new Set<string>()
let offWrite: (() => void) | null = null
let offConflict: (() => void) | null = null
let meterInterval: ReturnType<typeof setInterval> | null = null
let monitorStarted = false

// ── Lifecycle ────────────────────────────────────────────────────
onMounted(async () => {
  if (!inspector.value || !db.value) { initialized.value = true; return }
  try {
    vaults.value = await inspector.value.listVaults()
    const info = vaults.value[0]
    if (!info) { initialized.value = true; return }
    openVault.value = await db.value.openVault(info.id)
    await loadSnapshot()
  } catch (e) {
    snapshotError.value = e instanceof Error ? e.message : String(e)
  } finally {
    initialized.value = true
  }
})

onUnmounted(() => {
  offWrite?.()
  offConflict?.()
  if (meterInterval) clearInterval(meterInterval)
})

// ── Helpers ──────────────────────────────────────────────────────
async function loadSnapshot() {
  if (!inspector.value || !openVault.value) return
  try {
    const snap = await inspector.value.snapshot(openVault.value)
    collections.value = snap.collections
    snapshotMeta.value = snap.meta ?? null
    selectedCollection.value = snap.collections[0] ?? null
    snapshotError.value = undefined
  } catch (e) {
    snapshotError.value = e instanceof Error ? e.message : String(e)
  }
}

function selectCollection(coll: InspectorCollection) {
  selectedCollection.value = coll
  detailTab.value = 'schema'
  recordsOffset.value = 0
  recordsPage.value = null
  recordsError.value = undefined
}

function prevPage() { if (recordsOffset.value >= PAGE) recordsOffset.value -= PAGE }
function nextPage() {
  if (recordsPage.value && recordsOffset.value + PAGE < recordsPage.value.total)
    recordsOffset.value += PAGE
}

function activateMonitor() {
  topTab.value = 'monitor'
  if (monitorStarted || !inspector.value) return
  monitorStarted = true
  offWrite = inspector.value.subscribe((e) => {
    const op = e.op === 'delete' ? 'del' : ('put' as const)
    const versions = e.op === 'delete' ? `${e.baseVersion}→·` : `${e.baseVersion}→${e.version}`
    const baseKey = `${e.collection}/${e.docId}@${e.baseVersion}`
    const row: FeedRow = {
      time: new Date(e.timestamp).toTimeString().slice(0, 8),
      user: e.userId,
      op,
      target: `${e.collection}/${e.docId}`,
      versions,
      baseKey,
      conflict: conflictKeys.has(baseKey),
    }
    const prev = feed.value as FeedRow[]
    if (prev.some((r) => r.baseKey === baseKey && r.user !== e.userId)) row.conflict = true
    feed.value = [
      row,
      ...prev.map((r) => r.baseKey === baseKey && r.user !== e.userId ? { ...r, conflict: true } : r),
    ].slice(0, BUFFER)
  })
  offConflict = inspector.value.subscribeConflicts((c) => {
    const key = `${c.collection}/${c.docId}@${c.baseVersion}`
    conflictKeys.add(key)
    feed.value = (feed.value as FeedRow[]).map((r) => r.baseKey === key ? { ...r, conflict: true } : r)
  })
}

// Latency poll — runs only while monitor tab is active
watch(topTab, (tab) => {
  if (tab === 'monitor') {
    meterInterval = setInterval(() => {
      try { meter.value = inspector.value?.meterSnapshot() ?? null }
      catch { meter.value = null }
    }, 1000)
  } else {
    if (meterInterval) { clearInterval(meterInterval); meterInterval = null }
  }
})

// Records fetch — re-runs when collection, tab, or offset changes
watch(
  [selectedCollection, detailTab, recordsOffset],
  async ([coll, tab]) => {
    if (!inspector.value || !openVault.value || !coll || tab !== 'records') return
    recordsPage.value = null
    recordsError.value = undefined
    try {
      recordsPage.value = await inspector.value.records(
        openVault.value, coll.name, { limit: PAGE, offset: recordsOffset.value }
      )
    } catch (e) {
      recordsError.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: false }
)
</script>
