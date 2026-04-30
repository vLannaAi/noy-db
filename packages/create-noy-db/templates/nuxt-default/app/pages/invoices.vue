<script setup lang="ts">
import { DEFAULT_INVOICES } from '~/stores/invoices'

const invoices = useInvoices()
await invoices.$ready

// Seed on first run: if the store is empty and there are defaults, populate.
// This runs once on component mount; later visits see whatever the user
// has edited.
if (invoices.items.length === 0 && DEFAULT_INVOICES.length > 0) {
  for (const inv of DEFAULT_INVOICES) {
    invoices.add(inv)
  }
}

// Reactive query: re-runs whenever the underlying collection changes.
const open = invoices.query()
  .where('status', '==', 'open')
  .live()

function addDraft() {
  invoices.add({
    id: crypto.randomUUID(),
    client: 'New Client',
    amount: Math.round(Math.random() * 10000),
    status: 'draft',
    dueDate: new Date().toISOString().slice(0, 10),
  })
}

function remove(id: string) {
  invoices.remove(id)
}
</script>

<template>
  <section>
    <h1>Invoices</h1>
    <button @click="addDraft">+ New draft</button>
    <p><strong>{{ open.length }}</strong> open invoice(s)</p>
    <ul>
      <li v-for="inv in invoices.items" :key="inv.id">
        <strong>{{ inv.client }}</strong> — {{ inv.amount }} ({{ inv.status }})
        <button @click="remove(inv.id)">Delete</button>
      </li>
    </ul>
    <p v-if="invoices.items.length === 0">
      No invoices yet — click "New draft" to add one.
    </p>
  </section>
</template>

<style scoped>
button {
  cursor: pointer;
  padding: 0.25rem 0.75rem;
  margin: 0.25rem;
}
li {
  padding: 0.5rem 0;
}
</style>
