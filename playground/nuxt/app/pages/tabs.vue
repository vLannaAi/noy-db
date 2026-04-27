<!--
  Multi-tab sync demo using @noy-db/by-tabs.

  Open this page in two or more tabs of the same browser (same origin).
  Type a message in one tab; it appears in every other tab on the
  channel within microseconds — no round-trip to IndexedDB, no server.

  This is the canonical small example of the by-* transport family.
  The same `PeerChannel` shape is used by `@noy-db/by-peer` (WebRTC)
  and the planned `@noy-db/by-server` / `@noy-db/by-room` packages.
-->

<script setup lang="ts">
import { tabsChannel, isTabsChannelAvailable } from '@noy-db/by-tabs'
import type { PeerChannel } from '@noy-db/by-peer'

interface TabMessage {
  readonly id: string
  readonly text: string
  readonly at: number
}

const available = ref(false)
const messages = ref<TabMessage[]>([])
const draft = ref('')
const tabId = ref('')

let channel: PeerChannel | null = null

onMounted(() => {
  available.value = isTabsChannelAvailable()
  if (!available.value) return

  // Random tab id so we can tell our own messages from peer messages.
  tabId.value = Math.random().toString(36).slice(2, 10)

  channel = tabsChannel({ name: 'noy-db-playground:tabs-demo' })
  channel.on('message', (raw: string) => {
    try {
      const msg = JSON.parse(raw) as TabMessage
      messages.value = [msg, ...messages.value].slice(0, 50)
    } catch {
      // ignore malformed payloads
    }
  })
})

onBeforeUnmount(() => {
  channel?.close()
  channel = null
})

function send(): void {
  const text = draft.value.trim()
  if (!text || !channel) return
  const msg: TabMessage = {
    id: `${tabId.value}-${Date.now()}`,
    text: `[tab ${tabId.value}] ${text}`,
    at: Date.now(),
  }
  channel.send(JSON.stringify(msg))
  // Local echo — BroadcastChannel does NOT loop back to the sender.
  messages.value = [msg, ...messages.value].slice(0, 50)
  draft.value = ''
}
</script>

<template>
  <section>
    <h2>Multi-tab sync via <code>@noy-db/by-tabs</code></h2>

    <p v-if="!available" class="warn">
      <strong>BroadcastChannel is not available.</strong> Use a modern
      browser (Chrome 54+, Firefox 38+, Safari 15.4+). On older runtimes
      <code>tabsChannel()</code> returns a no-op channel so consumer
      code stays import-safe.
    </p>

    <template v-else>
      <p>
        This tab's id: <code>{{ tabId }}</code>. Open this page in
        another browser tab to see messages propagate without a server,
        without IndexedDB, without anything but the browser's
        <code>BroadcastChannel</code>.
      </p>

      <form @submit.prevent="send">
        <input v-model="draft" placeholder="type a message…" />
        <button type="submit" :disabled="!draft.trim()">Broadcast</button>
      </form>

      <ul class="log">
        <li v-for="m in messages" :key="m.id">
          <time>{{ new Date(m.at).toLocaleTimeString() }}</time>
          <span>{{ m.text }}</span>
        </li>
        <li v-if="messages.length === 0" class="empty">
          No messages yet. Open this page in a second tab and try.
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

h2 {
  margin: 0;
  font-size: 1.2rem;
}

p code {
  background: #f3f4f6;
  padding: 0.1em 0.3em;
  border-radius: 0.2em;
  font-size: 0.85em;
}

.warn {
  background: #fef3c7;
  border: 1px solid #fbbf24;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
  font-size: 0.9rem;
}

form {
  display: flex;
  gap: 0.5rem;
}

form input {
  flex: 1;
}

.log {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid #e5e7eb;
  border-radius: 0.25rem;
  background: white;
  max-height: 320px;
  overflow-y: auto;
}

.log li {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #f3f4f6;
  display: flex;
  gap: 0.75rem;
  font-size: 0.875rem;
}

.log li:last-child {
  border-bottom: none;
}

.log time {
  color: #6b7280;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.log .empty {
  color: #9ca3af;
  font-style: italic;
}
</style>
