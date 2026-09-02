# @noy-db/shamir

## 0.7.1-pre.0

### Patch Changes

- **`@noy-db/shamir` (new):** Shamir Secret Sharing over GF(2^8) and the share codecs, extracted from `@noy-db/on-shamir` as a zero-dependency primitive with no hub contract. `@noy-db/on-shamir` now depends on this package and re-exports its surface; import from here when composing threshold sharing into something that is not a noy-db unlock method. Error messages are prefixed `shamir:`.

  **`@noy-db/hub`:** Hub's recovery tests no longer depend on `@noy-db/on-shamir`; they exercise the real k-of-n math through `@noy-db/shamir`. `packages/on-shamir` has left this repository for `vLannaAi/noy-db-on` — `@noy-db/on-shamir@0.7.0` is the last version published from here; later versions come from noy-db-on on its own line. No runtime change: `NoydbShamir` on `@noy-db/hub/on` is unchanged and is now the only declaration of that interface in the family. (Second half of #211.)
