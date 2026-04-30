<script setup lang="ts">
import { ref } from 'vue'
import type { Invoice } from '../stores/invoices'

const emit = defineEmits<{ (e: 'submit', invoice: Invoice): void }>()

const client = ref('')
const amount = ref<number | null>(null)
const status = ref<Invoice['status']>('draft')

function submit() {
  if (!client.value || amount.value === null || Number.isNaN(amount.value)) return
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  emit('submit', {
    id,
    client: client.value,
    amount: amount.value,
    status: status.value,
    issueDate: new Date().toISOString().slice(0, 10),
  })
  client.value = ''
  amount.value = null
  status.value = 'draft'
}
</script>

<template>
  <form class="add-form" @submit.prevent="submit">
    <input v-model="client" placeholder="Client name" required />
    <input v-model.number="amount" type="number" min="0" step="0.01" placeholder="Amount" required />
    <select v-model="status">
      <option value="draft">draft</option>
      <option value="open">open</option>
      <option value="paid">paid</option>
      <option value="overdue">overdue</option>
    </select>
    <button type="submit">Add invoice</button>
  </form>
</template>
