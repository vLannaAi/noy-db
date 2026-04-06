/**
 * Clients store — second Pinia store proving multi-store isolation
 * within the same compartment.
 */

// defineNoydbStore is auto-imported by @noy-db/nuxt

export interface Client {
  id: string
  name: string
  email: string
  createdAt: string
}

export const useClients = defineNoydbStore<Client>('clients', {
  compartment: 'demo-co',
})
