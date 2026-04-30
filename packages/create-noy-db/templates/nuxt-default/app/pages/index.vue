<script setup lang="ts">
// Landing page for the generated noy-db app.
</script>

<template>
  <section>
    <h1>{{PROJECT_NAME}}</h1>
    <p>
      Encrypted, offline-first, zero-knowledge document store powered by
      <a href="https://github.com/vLannaAi/noy-db">noy-db</a>.
    </p>
    <p>
      Visit <NuxtLink to="/invoices">/invoices</NuxtLink> to see the demo
      invoices store.
    </p>
    <p>
      Run <code>noy-db verify</code> at any time to check the integrity of
      your noy-db install.
    </p>
  </section>
</template>
