import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { port: 5174 },
  // Target modern evergreen browsers — required for top-level await
  // (used in main.ts to create the Noydb instance before mounting Vue).
  build: {
    target: 'es2022',
  },
  esbuild: {
    target: 'es2022',
  },
})
