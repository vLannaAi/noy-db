<!--
  Dashboard page. Aggregates counts from both stores and shows a
  short summary of the open/overdue invoices. Every number here comes
  through the Pinia API — no direct NOYDB access.
-->

<script setup lang="ts">
import { useInvoices } from '~/stores/invoices'
import { useClients } from '~/stores/clients'

const invoices = useInvoices()
const clients = useClients()

// Nuxt 4's SSR skeleton state: until the client-only bootstrap plugin
// runs, both stores throw on $ready. We guard with ClientOnly below so
// the SSR HTML is a placeholder rather than an error.
const ready = ref(false)
const error = ref<Error | null>(null)

onMounted(async () => {
  try {
    await Promise.all([invoices.$ready, clients.$ready])
    ready.value = true
  } catch (err) {
    error.value = err instanceof Error ? err : new Error(String(err))
  }
})

// All reactive — recomputes whenever the stores mutate.
const openCount = computed(() =>
  invoices.items.filter((i) => i.status === 'open').length,
)
const overdueCount = computed(() =>
  invoices.items.filter((i) => i.status === 'overdue').length,
)
const paidCount = computed(() =>
  invoices.items.filter((i) => i.status === 'paid').length,
)
const totalOutstanding = computed(() =>
  invoices.items
    .filter((i) => i.status === 'open' || i.status === 'overdue')
    .reduce((sum, i) => sum + i.amount, 0),
)
</script>

<template>
  <section>
    <h2>Dashboard</h2>

    <ClientOnly>
      <div v-if="error" class="error">
        <strong>Bootstrap failed:</strong> {{ error.message }}
      </div>
      <div v-else-if="!ready" class="loading">
        Unlocking encrypted store…
      </div>
      <div v-else>
        <div class="stats">
          <div class="stat">
            <div class="stat-value">{{ clients.count }}</div>
            <div class="stat-label">Clients</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ invoices.count }}</div>
            <div class="stat-label">Invoices</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ openCount }}</div>
            <div class="stat-label">Open</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ overdueCount }}</div>
            <div class="stat-label">Overdue</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ paidCount }}</div>
            <div class="stat-label">Paid</div>
          </div>
        </div>

        <p class="outstanding">
          Outstanding balance:
          <strong>{{ totalOutstanding.toLocaleString() }}</strong>
        </p>

        <div class="actions">
          <NuxtLink to="/invoices">
            <button>Manage invoices</button>
          </NuxtLink>
          <NuxtLink to="/clients">
            <button class="secondary">Manage clients</button>
          </NuxtLink>
        </div>
      </div>

      <template #fallback>
        <p class="loading">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.stat {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem;
  text-align: center;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #1f2937;
}

.stat-label {
  font-size: 0.75rem;
  color: #6b7280;
  text-transform: uppercase;
  margin-top: 0.25rem;
}

.outstanding {
  font-size: 1.1rem;
  color: #4b5563;
}

.outstanding strong {
  color: #dc2626;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
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
