<script setup lang="ts">
// Top-level layout. Add navigation here as you grow the app.
</script>

<template>
  <div>
    <header>
      <nav>
        <NuxtLink to="/">Home</NuxtLink>
        <NuxtLink to="/invoices">Invoices</NuxtLink>
      </nav>
    </header>
    <main>
      <NuxtPage />
    </main>
  </div>
</template>

<style>
nav {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  border-bottom: 1px solid #e5e5e5;
}
nav a {
  text-decoration: none;
  color: #0070f3;
}
nav a.router-link-active {
  font-weight: bold;
}
main {
  padding: 1rem;
  font-family: system-ui, sans-serif;
}
</style>
