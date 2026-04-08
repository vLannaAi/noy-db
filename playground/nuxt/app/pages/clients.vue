<!--
  Clients page — second store, showing multi-store isolation.
-->

<script setup lang="ts">
import { useClients, type Client } from '~/stores/clients'

const clients = useClients()
const ready = ref(false)
const error = ref<Error | null>(null)

onMounted(async () => {
  try {
    await clients.$ready
    ready.value = true
  } catch (err) {
    error.value = err instanceof Error ? err : new Error(String(err))
  }
})

const form = ref({ name: '', email: '' })
const formError = ref<string | null>(null)

async function addClient(): Promise<void> {
  formError.value = null
  if (!form.value.name.trim()) {
    formError.value = 'Client name is required'
    return
  }
  const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await clients.add(id, {
    id,
    name: form.value.name.trim(),
    email: form.value.email.trim(),
    createdAt: new Date().toISOString(),
  })
  form.value = { name: '', email: '' }
}

async function removeClient(id: string): Promise<void> {
  await clients.remove(id)
}

// Keep the list sorted by name — ascending.
const sorted = computed<Client[]>(() => {
  if (!ready.value) return []
  return clients.query().orderBy('name', 'asc').toArray()
})
</script>

<template>
  <section>
    <h2>Clients</h2>

    <ClientOnly>
      <div v-if="error" class="error">
        <strong>Bootstrap failed:</strong> {{ error.message }}
      </div>
      <div v-else-if="!ready" class="loading">
        Unlocking encrypted store…
      </div>
      <div v-else>
        <div class="new-form">
          <input v-model="form.name" placeholder="Name" />
          <input v-model="form.email" type="email" placeholder="Email (optional)" />
          <button @click="addClient">Add</button>
        </div>
        <p v-if="formError" class="form-error">{{ formError }}</p>

        <p v-if="sorted.length === 0" class="empty">
          No clients yet.
        </p>
        <table v-else>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in sorted" :key="c.id">
              <td>{{ c.name }}</td>
              <td>{{ c.email || '—' }}</td>
              <td>{{ c.createdAt.slice(0, 10) }}</td>
              <td>
                <button class="link" @click="removeClient(c.id)">delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template #fallback>
        <p class="loading">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.new-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.new-form input {
  flex: 1;
}

.form-error {
  color: #b91c1c;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.empty {
  color: #9ca3af;
  font-style: italic;
  text-align: center;
  padding: 2rem;
}

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
