<script setup lang="ts">
import { ref, computed } from 'vue'
import { useInvoices, type Invoice } from './stores/invoices'

const invoices = useInvoices()
await invoices.$ready

// Local form state.
const form = ref<Omit<Invoice, 'id'>>({
  amount: 0,
  status: 'draft',
  client: '',
  dueDate: new Date().toISOString().slice(0, 10),
})

// Filter state — demonstrates the chainable query DSL.
const statusFilter = ref<'all' | 'draft' | 'open' | 'paid' | 'overdue'>('all')
const minAmount = ref<number | null>(null)

const filtered = computed<Invoice[]>(() => {
  let q = invoices.query()
  if (statusFilter.value !== 'all') q = q.where('status', '==', statusFilter.value)
  if (minAmount.value !== null && minAmount.value > 0) q = q.where('amount', '>=', minAmount.value)
  return q.orderBy('dueDate', 'asc').toArray()
})

const totalAmount = computed(() =>
  filtered.value.reduce((sum, inv) => sum + inv.amount, 0),
)

async function addInvoice(): Promise<void> {
  if (!form.value.client || form.value.amount <= 0) return
  const id = `inv-${Date.now()}`
  await invoices.add(id, { id, ...form.value })
  form.value = { amount: 0, status: 'draft', client: '', dueDate: new Date().toISOString().slice(0, 10) }
}

async function removeInvoice(id: string): Promise<void> {
  await invoices.remove(id)
}

async function seed(): Promise<void> {
  const samples: Array<Omit<Invoice, 'id'>> = [
    { amount: 1500, status: 'open',    client: 'Alpha Co.',   dueDate: '2026-04-15' },
    { amount: 2800, status: 'paid',    client: 'Bravo Ltd.',  dueDate: '2026-03-01' },
    { amount: 5000, status: 'overdue', client: 'Charlie Inc', dueDate: '2026-02-28' },
    { amount: 200,  status: 'draft',   client: 'Delta LLC',   dueDate: '2026-05-10' },
    { amount: 9999, status: 'open',    client: 'Echo Group',  dueDate: '2026-06-01' },
  ]
  for (const s of samples) {
    await invoices.add(`seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, {
      id: '',
      ...s,
    })
  }
}

async function clearAll(): Promise<void> {
  for (const inv of [...invoices.items]) {
    await invoices.remove(inv.id)
  }
}
</script>

<template>
  <main class="page">
    <header>
      <h1>NOYDB + Pinia playground</h1>
      <p class="subtitle">
        A reactive, encrypted Pinia store with the chainable query DSL.
        Records are AES-256-GCM encrypted in IndexedDB —
        the adapter never sees plaintext.
      </p>
    </header>

    <section class="card">
      <h2>Add invoice</h2>
      <div class="form">
        <input v-model="form.client" placeholder="Client" />
        <input v-model.number="form.amount" type="number" placeholder="Amount" />
        <select v-model="form.status">
          <option value="draft">draft</option>
          <option value="open">open</option>
          <option value="paid">paid</option>
          <option value="overdue">overdue</option>
        </select>
        <input v-model="form.dueDate" type="date" />
        <button @click="addInvoice">Add</button>
      </div>
      <div class="actions">
        <button @click="seed">Seed 5 samples</button>
        <button @click="clearAll" class="danger">Clear all</button>
      </div>
    </section>

    <section class="card">
      <h2>Query DSL filter</h2>
      <div class="form">
        <label>
          Status:
          <select v-model="statusFilter">
            <option value="all">all</option>
            <option value="draft">draft</option>
            <option value="open">open</option>
            <option value="paid">paid</option>
            <option value="overdue">overdue</option>
          </select>
        </label>
        <label>
          Min amount:
          <input v-model.number="minAmount" type="number" placeholder="0" />
        </label>
      </div>
      <p>
        <strong>{{ filtered.length }}</strong> matching invoices,
        total <strong>{{ totalAmount.toLocaleString() }}</strong>
        (out of {{ invoices.count }} total)
      </p>
    </section>

    <section class="card">
      <h2>Filtered results (live, ordered by due date)</h2>
      <table v-if="filtered.length > 0">
        <thead>
          <tr>
            <th>Client</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Due</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in filtered" :key="inv.id">
            <td>{{ inv.client }}</td>
            <td>{{ inv.amount.toLocaleString() }}</td>
            <td>
              <span :class="`status status-${inv.status}`">{{ inv.status }}</span>
            </td>
            <td>{{ inv.dueDate }}</td>
            <td><button @click="removeInvoice(inv.id)" class="link">delete</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">No invoices match the current filter.</p>
    </section>

    <footer>
      <p>
        <strong>How it works:</strong>
        <code>defineNoydbStore</code> wraps a Pinia store around a NOYDB
        collection. <code>add()</code> encrypts the record with the
        compartment's DEK and writes it to IndexedDB. The store's
        <code>items</code> ref is reactive — Vue re-renders automatically.
        Open DevTools → Application → IndexedDB to see the ciphertext.
      </p>
      <p>
        <strong>Source:</strong>
        <a href="https://github.com/vLannaAi/noy-db/tree/main/playground/pinia" target="_blank" rel="noopener">playground/pinia</a>
      </p>
    </footer>
  </main>
</template>

<style scoped>
.page {
  max-width: 880px;
  margin: 2rem auto;
  padding: 0 1rem;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1f2937;
}

header h1 {
  margin-bottom: 0.25rem;
  font-size: 1.875rem;
}

.subtitle {
  color: #6b7280;
  margin-top: 0;
}

.card {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  margin: 1rem 0;
}

.card h2 {
  margin-top: 0;
  font-size: 1.125rem;
}

.form {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.form input,
.form select {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  font-size: 0.9rem;
}

.actions {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.5rem;
}

button {
  padding: 0.4rem 0.8rem;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: white;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.875rem;
}

button:hover {
  background: #1d4ed8;
}

button.danger {
  background: #dc2626;
  border-color: #dc2626;
}

button.danger:hover {
  background: #b91c1c;
}

button.link {
  background: transparent;
  color: #dc2626;
  border: none;
  text-decoration: underline;
  padding: 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.5rem;
}

th, td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.875rem;
}

th {
  background: #f3f4f6;
  font-weight: 600;
}

.status {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
}

.status-draft   { background: #f3f4f6; color: #4b5563; }
.status-open    { background: #dbeafe; color: #1d4ed8; }
.status-paid    { background: #dcfce7; color: #15803d; }
.status-overdue { background: #fee2e2; color: #b91c1c; }

.empty {
  color: #9ca3af;
  font-style: italic;
}

footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
  color: #6b7280;
  font-size: 0.875rem;
}

footer code {
  background: #f3f4f6;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
</style>
