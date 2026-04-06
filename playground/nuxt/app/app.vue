<!--
  Root app shell for the Nuxt 4 reference demo.

  Every page sits inside this layout. The nav bar is minimal — just
  four links — because the point of the demo is showing the Pinia/NOYDB
  integration, not the UI framework.
-->

<template>
  <div class="app">
    <header>
      <h1>NOYDB × Nuxt 4 demo</h1>
      <nav>
        <NuxtLink to="/">Dashboard</NuxtLink>
        <NuxtLink to="/invoices">Invoices</NuxtLink>
        <NuxtLink to="/clients">Clients</NuxtLink>
      </nav>
    </header>

    <main>
      <NuxtPage />
    </main>

    <footer>
      <p>
        Encrypted with AES-256-GCM. Open DevTools → Application →
        IndexedDB to see the ciphertext.
      </p>
    </footer>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1f2937;
  background: #f9fafb;
}

.app {
  max-width: 900px;
  margin: 0 auto;
  padding: 1rem;
}

header {
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
}

header h1 {
  font-size: 1.5rem;
  margin: 0 0 0.5rem 0;
}

nav {
  display: flex;
  gap: 1rem;
}

nav a {
  color: #2563eb;
  text-decoration: none;
  font-size: 0.9rem;
}

nav a.router-link-active {
  font-weight: 600;
  color: #1e40af;
}

main {
  min-height: 60vh;
}

footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
  color: #6b7280;
  font-size: 0.85rem;
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

button.secondary {
  background: white;
  color: #2563eb;
}

button.danger {
  background: #dc2626;
  border-color: #dc2626;
}

input,
select {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  font-size: 0.9rem;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.875rem;
}

th {
  background: #f3f4f6;
  font-weight: 600;
}
</style>
