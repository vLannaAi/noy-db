<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useInvoices, DEFAULT_INVOICES, type Invoice } from './stores/invoices'
import InvoiceTable from './components/InvoiceTable.vue'
import AddInvoiceForm from './components/AddInvoiceForm.vue'

const store = useInvoices()
const ready = ref(false)

onMounted(async () => {
  await store.$ready

  // Seed the collection on first load so the demo shows something.
  if (store.items.length === 0) {
    for (const inv of DEFAULT_INVOICES) {
      await store.add(inv.id, inv)
    }
  }
  ready.value = true
})

async function onAdd(invoice: Invoice) {
  await store.add(invoice.id, invoice)
}

async function onRemove(id: string) {
  await store.remove(id)
}
</script>

<template>
  <div class="app">
    <header>
      <h1>{{PROJECT_NAME}}</h1>
      <p class="subtitle">
        Encrypted invoices backed by noy-db + Vue 3 + Pinia.
        Open DevTools → Application → IndexedDB to see ciphertext only.
      </p>
    </header>

    <main v-if="ready">
      <section class="summary">
        <div class="stat">
          <div class="label">Invoices</div>
          <div class="value">{{ store.count }}</div>
        </div>
        <div class="stat">
          <div class="label">Total (open)</div>
          <div class="value">
            {{
              store.items
                .filter((i) => i.status === 'open')
                .reduce((n, i) => n + i.amount, 0)
                .toLocaleString()
            }}
          </div>
        </div>
      </section>

      <AddInvoiceForm @submit="onAdd" />

      <InvoiceTable :invoices="store.items" @remove="onRemove" />
    </main>

    <p v-else class="loading">Unlocking vault…</p>

    <footer>
      <p>
        AES-256-GCM at rest. Key derived from your passphrase via
        PBKDF2-SHA256 (600 000 iterations). Lose the passphrase and
        the data is unrecoverable — by design.
      </p>
    </footer>
  </div>
</template>
