# Issue #221 — feat(to-stego): @noy-db/to-stego — steganographic bundle store (ciphertext hidden in JPEG/PNG/PDF)

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-21

- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, priority: low, area: adapters

---

Hide noy-db vault bytes inside cover files (JPEG LSB, PNG alpha channel, PDF stream objects) that still open normally in standard viewers. Adversary cannot distinguish a stego-vault from a regular family photo without the key + the stego passphrase. Use cases: dissident / journalist / humanitarian-NGO deployments where possession of an "obvious encrypted blob" is itself a risk. Priority: low — niche but important positioning. Implementation uses standard steganography libraries (LSB is well-known; PNG alpha is simpler).
