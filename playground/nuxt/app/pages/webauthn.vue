<!--
  Interactive WebAuthn demo — biometric / passkey unlock.

  Open this page in a real browser (not vitest happy-dom). Clicking
  "Create passkey" triggers `navigator.credentials.create()` and
  prompts the user's platform authenticator (Touch ID, Windows Hello,
  security key). Clicking "Unlock" triggers `.get()`.

  Both flows use the real `@noy-db/on-webauthn` API — no mocks. The
  automated vitest equivalent lives at
  `showcases/src/13-webauthn.showcase.test.ts` (with a synthetic
  authenticator because happy-dom has no `navigator.credentials`).
-->

<script setup lang="ts">
import {
  enrollWebAuthn,
  unlockWebAuthn,
  isWebAuthnAvailable,
  type WebAuthnEnrollment,
} from '@noy-db/on-webauthn'
import type { UnlockedKeyring } from '@noy-db/hub'

// The WebAuthn bridge wraps an already-unlocked keyring. For this demo
// we build one directly (one DEK, owner role). In a real app the
// keyring comes out of the normal passphrase unlock path.
async function makeDemoKeyring(): Promise<UnlockedKeyring> {
  const dek = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId: 'demo-user',
    displayName: 'Demo User',
    role: 'owner',
    permissions: { notes: 'rw' },
    deks: new Map([['notes', dek]]),
    kek: null as unknown as CryptoKey,
    salt: new Uint8Array(32).fill(5),
  }
}

// Reactive state — `ref` for single values, composable-free because this
// page doesn't need Pinia or a shared store.
const available = ref(false)
const enrollment = ref<WebAuthnEnrollment | null>(null)
const unlocked = ref<UnlockedKeyring | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

onMounted(() => {
  // `isWebAuthnAvailable()` is SSR-unsafe — it touches `window` and
  // `PublicKeyCredential`. Only run it after the client mounts.
  available.value = isWebAuthnAvailable()
})

async function handleEnroll() {
  error.value = null
  busy.value = true
  try {
    const keyring = await makeDemoKeyring()
    // Triggers the platform authenticator prompt — Touch ID / Face ID
    // / Windows Hello / security key. The returned enrolment record
    // contains a `wrappedPayload` (ciphertext) + public metadata.
    const result = await enrollWebAuthn(keyring, 'demo-vault', {
      rp: { id: window.location.hostname, name: 'noy-db WebAuthn demo' },
    })
    enrollment.value = result
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function handleUnlock() {
  if (!enrollment.value) return
  error.value = null
  busy.value = true
  try {
    // A second biometric prompt — the authenticator proves possession
    // of the same credential and (if supported) produces the same PRF
    // output, reconstructing the wrapping key.
    const keyring = await unlockWebAuthn(enrollment.value)
    unlocked.value = keyring
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function handleReset() {
  enrollment.value = null
  unlocked.value = null
  error.value = null
}
</script>

<template>
  <section>
    <h2>WebAuthn — passkey / biometric unlock</h2>
    <p class="lede">
      Real end-to-end demo of
      <code>@noy-db/on-webauthn</code>. Nothing is mocked — the
      browser prompts your real authenticator.
    </p>

    <ClientOnly>
      <div v-if="!available" class="warn">
        <strong>WebAuthn is not available here.</strong>
        This environment lacks <code>navigator.credentials</code>.
        Open this page in a recent Chrome / Firefox / Safari over HTTPS
        (or <code>localhost</code>, which browsers treat as a secure
        context).
      </div>

      <div v-else>
        <!-- Stage 1: enrolment -->
        <section v-if="!enrollment" class="stage">
          <h3>Step 1 — create passkey</h3>
          <p>
            Click below. Your browser will ask to create a passkey
            (platform authenticator — Touch ID / Face ID / Windows
            Hello) or use a security key. The resulting credential
            wraps an in-memory keyring.
          </p>
          <button :disabled="busy" @click="handleEnroll">
            {{ busy ? 'Prompting…' : 'Create passkey' }}
          </button>
        </section>

        <!-- Stage 2: enrolment done, ready to unlock -->
        <section v-else-if="!unlocked" class="stage">
          <h3>Step 2 — unlock with the same passkey</h3>
          <p>
            Enrolment stored. The wrapped payload below is AES-GCM
            ciphertext — the authenticator alone can produce the
            wrapping key. Click to prove it by unlocking.
          </p>
          <details>
            <summary>Enrolment record (public fields plaintext, payload ciphertext)</summary>
            <pre>{{ JSON.stringify({
              vault: enrollment.vault,
              userId: enrollment.userId,
              credentialId: enrollment.credentialId,
              prfUsed: enrollment.prfUsed,
              beFlag: enrollment.beFlag,
              enrolledAt: enrollment.enrolledAt,
              wrappedPayload: enrollment.wrappedPayload.slice(0, 48) + '…',
              wrapIv: enrollment.wrapIv,
            }, null, 2) }}</pre>
          </details>
          <div class="actions">
            <button :disabled="busy" @click="handleUnlock">
              {{ busy ? 'Prompting…' : 'Unlock with passkey' }}
            </button>
            <button class="secondary" :disabled="busy" @click="handleReset">
              Start over
            </button>
          </div>
        </section>

        <!-- Stage 3: unlocked -->
        <section v-else class="stage success">
          <h3>✓ Unlocked</h3>
          <p>
            The authenticator reconstructed the wrapping key, decrypted
            the payload, and produced a live keyring. DEKs are real
            <code>CryptoKey</code> objects ready for AES-GCM encrypt /
            decrypt.
          </p>
          <pre>{{ JSON.stringify({
            userId: unlocked.userId,
            displayName: unlocked.displayName,
            role: unlocked.role,
            permissions: unlocked.permissions,
            dekCount: unlocked.deks.size,
            dekCollections: Array.from(unlocked.deks.keys()),
          }, null, 2) }}</pre>
          <button @click="handleReset">Reset demo</button>
        </section>

        <div v-if="error" class="error">
          <strong>Error:</strong> {{ error }}
        </div>
      </div>

      <template #fallback>
        <p class="loading">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.lede {
  color: #4b5563;
  font-size: 0.95rem;
}

.stage {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1.25rem 1.5rem;
  margin: 1rem 0;
}

.stage h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1.1rem;
}

.stage.success {
  border-color: #059669;
  background: #ecfdf5;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.warn {
  background: #fef3c7;
  color: #92400e;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
}

.error {
  background: #fee2e2;
  color: #b91c1c;
  padding: 0.75rem 1rem;
  border-radius: 0.25rem;
  margin-top: 1rem;
}

.loading {
  color: #6b7280;
  font-style: italic;
}

details {
  margin: 0.75rem 0;
  font-size: 0.85rem;
}

details summary {
  cursor: pointer;
  color: #2563eb;
  user-select: none;
}

pre {
  background: #1f2937;
  color: #e5e7eb;
  padding: 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.8rem;
  overflow-x: auto;
  margin: 0.5rem 0;
}
</style>
