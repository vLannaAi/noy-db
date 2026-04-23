# Issue #213 — feat(to-qr): @noy-db/to-qr — encrypted vault export to scannable QR sequence

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-21

- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

Air-gap transfer without USB. Encrypted vault bytes split into a sequence of QR codes (with Reed-Solomon erasure so a missing frame does not break the chain). Receiver scans → reassembles → decrypts. Use cases: cross-device transfer without wifi, physical-secure vault migration, dissident workflows. Likely depends on a QR library (qrcode + jsQR are de-facto). Resumable — encode a chunk index so partial captures are recoverable.
