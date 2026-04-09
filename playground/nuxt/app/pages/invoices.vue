<!--
  Invoices page — the main v0.3 dogfood test.

  Exercises the full Pinia + query DSL surface:
    - defineNoydbStore returning a reactive items array
    - add(), remove() mutations through the store
    - query().where().orderBy().toArray() reactive filtering
    - schema validation via a tiny inline validator (shows the pattern
      without pulling in Zod as a demo dependency)

  Only the Pinia store is imported — no Compartment/Collection/createNoydb
  calls in this file. That's the v0.3 acceptance criterion.
-->

<script setup lang="ts">
import { useInvoices, type Invoice } from '~/stores/invoices'

const invoices = useInvoices()

const ready = ref(false)
const error = ref<Error | null>(null)

onMounted(async () => {
  try {
    await invoices.$ready
    ready.value = true
  } catch (err) {
    error.value = err instanceof Error ? err : new Error(String(err))
  }
})

// Filter state — every field is reactive through the query DSL.
const statusFilter = ref<'all' | Invoice['status']>('all')
const minAmount = ref<number | null>(null)

// The reactive query. Pinia auto-recomputes this when `invoices.items`
// changes (add/update/remove) — no manual wiring needed.
const filtered = computed<Invoice[]>(() => {
  if (!ready.value) return []
  let q = invoices.query()
  if (statusFilter.value !== 'all') {
    q = q.where('status', '==', statusFilter.value)
  }
  if (minAmount.value !== null && minAmount.value > 0) {
    q = q.where('amount', '>=', minAmount.value)
  }
  return q.orderBy('dueDate', 'asc').toArray()
})

// New-invoice form state.
const form = ref({
  client: '',
  amount: 0,
  status: 'draft' as Invoice['status'],
  dueDate: new Date().toISOString().slice(0, 10),
})

const formError = ref<string | null>(null)

async function addInvoice(): Promise<void> {
  formError.value = null
  if (!form.value.client.trim()) {
    formError.value = 'Client name is required'
    return
  }
  if (form.value.amount <= 0) {
    formError.value = 'Amount must be greater than zero'
    return
  }
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await invoices.add(id, {
    id,
    client: form.value.client.trim(),
    amount: form.value.amount,
    status: form.value.status,
    dueDate: form.value.dueDate,
  })
  // Reset the form.
  form.value = {
    client: '',
    amount: 0,
    status: 'draft',
    dueDate: new Date().toISOString().slice(0, 10),
  }
}

async function removeInvoice(id: string): Promise<void> {
  await invoices.remove(id)
}

async function seedDemo(): Promise<void> {
  const samples: Array<Omit<Invoice, 'id'>> = [
    { client: 'Alpha Cooperative', amount: 1500, status: 'open', dueDate: '2026-04-15' },
    { client: 'Bravo Holdings', amount: 2800, status: 'paid', dueDate: '2026-03-01' },
    { client: 'Charlie Industries', amount: 5000, status: 'overdue', dueDate: '2026-02-28' },
    { client: 'Delta Ventures', amount: 200, status: 'draft', dueDate: '2026-05-10' },
    { client: 'Echo Partners', amount: 9999, status: 'open', dueDate: '2026-06-01' },
  ]
  for (const sample of samples) {
    const id = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await invoices.add(id, { id, ...sample })
  }
}
</script>

<template>
  <section>
    <h2>Invoices</h2>

    <ClientOnly>
      <div v-if="error" class="error">
        <strong>Bootstrap failed:</strong> {{ error.message }}
      </div>
      <div v-else-if="!ready" class="loading">
        Unlocking encrypted store…
      </div>
      <div v-else>
        <!-- Add new invoice -->
        <details class="new-form">
          <summary>Add invoice</summary>
          <div class="form-grid">
            <label>
              Client
              <input v-model="form.client" placeholder="Client name" />
            </label>
            <label>
              Amount
              <input v-model.number="form.amount" type="number" min="0" />
            </label>
            <label>
              Status
              <select v-model="form.status">
                <option value="draft">draft</option>
                <option value="open">open</option>
                <option value="paid">paid</option>
                <option value="overdue">overdue</option>
              </select>
            </label>
            <label>
              Due date
              <input v-model="form.dueDate" type="date" />
            </label>
            <div>
              <button @click="addInvoice">Add</button>
            </div>
          </div>
          <p v-if="formError" class="form-error">{{ formError }}</p>
        </details>

        <!-- Filter controls driving the reactive query -->
        <div class="filters">
          <label>
            Status:
            <select v-model="statusFilter">
              <option value="all">All</option>
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
          <span class="count">
            {{ filtered.length }} of {{ invoices.count }} match
          </span>
        </div>

        <!-- Empty state + seed button for first-run UX -->
        <div v-if="invoices.count === 0" class="empty">
          <p>No invoices yet.</p>
          <button class="secondary" @click="seedDemo">Seed 5 samples</button>
        </div>

        <table v-else-if="filtered.length > 0">
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
              <td>
                <button class="link" @click="removeInvoice(inv.id)">delete</button>
              </td>
            </tr>
          </tbody>
        </table>

        <p v-else class="empty">No invoices match the current filter.</p>
      </div>

      <template #fallback>
        <p class="loading">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.new-form {
  margin-bottom: 1rem;
  padding: 0.75rem 1rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}

.new-form summary {
  cursor: pointer;
  font-weight: 600;
  color: #2563eb;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-top: 0.75rem;
  align-items: end;
}

.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: #4b5563;
}

.form-error {
  color: #b91c1c;
  font-size: 0.85rem;
  margin-top: 0.5rem;
}

.filters {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  background: #f3f4f6;
  border-radius: 0.25rem;
}

.filters label {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.9rem;
}

.count {
  margin-left: auto;
  color: #6b7280;
  font-size: 0.85rem;
}

.empty {
  color: #9ca3af;
  font-style: italic;
  text-align: center;
  padding: 2rem;
}

.empty button {
  margin-top: 0.75rem;
  font-style: normal;
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

button.link {
  background: transparent;
  color: #dc2626;
  border: none;
  text-decoration: underline;
  padding: 0;
}

.loading {
  color: #6b7280;
  font-style: italic;
}

.error {
  background: #fee2e2;
  color: #b91c1c;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
}
</style>
