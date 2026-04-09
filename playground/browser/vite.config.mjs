import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    include: ['@noy-db/core', '@noy-db/browser', '@noy-db/memory'],
  },
})
