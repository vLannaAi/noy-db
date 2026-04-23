<script setup lang="ts">
import type { Invoice } from '../stores/invoices'

defineProps<{ invoices: Invoice[] }>()
const emit = defineEmits<{ (e: 'remove', id: string): void }>()
</script>

<template>
  <section class="invoices">
    <h2>Invoices</h2>
    <table v-if="invoices.length > 0">
      <thead>
        <tr>
          <th>ID</th>
          <th>Client</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Issued</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inv in invoices" :key="inv.id">
          <td>{{ inv.id }}</td>
          <td>{{ inv.client }}</td>
          <td>{{ inv.amount.toLocaleString() }}</td>
          <td>
            <span :class="`status-pill status-${inv.status}`">{{ inv.status }}</span>
          </td>
          <td>{{ inv.issueDate }}</td>
          <td>
            <button class="danger" @click="emit('remove', inv.id)">×</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty">
      No invoices yet — add one above.
    </p>
  </section>
</template>
