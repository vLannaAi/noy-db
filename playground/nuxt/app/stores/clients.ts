/**
 * Clients store — second Pinia store proving multi-store isolation
 * within the same vault.
 */

// defineNoydbStore is auto-imported by @noy-db/in-nuxt

export interface Client {
  id: string
  name: string
  email: string
  createdAt: string
}

export const useClients = defineNoydbStore<Client>('clients', {
  vault: 'demo-co',
})
