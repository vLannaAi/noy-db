# WinZip-AES-256 Interop Matrix

Password used in all fixtures: `noydb-interop-2026`

`CI` = covered by automated GitHub Actions job. `?` = manual sign-off needed. Update `?` cells after running `pnpm interop:fixtures` and testing in each tool.

## Our writer → their reader

| Tool | OS | 1-byte | 16-byte | non-ASCII | 1 MiB | Tester | Date |
|---|---|:---:|:---:|:---:|:---:|---|---|
| 7-Zip 24.x | Ubuntu 24 | CI | CI | CI | CI | — | — |
| 7-Zip 24.x | macOS 15 | CI | CI | CI | CI | — | — |
| 7-Zip 24.x | Windows 11 | CI | CI | CI | CI | — | — |
| unar 1.10 | Ubuntu 24 | CI | CI | CI | CI | — | — |
| unar 1.10 | macOS 15 | CI | CI | CI | CI | — | — |
| Archive Utility | macOS 15 | ✅ | ✅ | ✅ | ✅ | vLannaAi | 2026-04-30 |
| WinRAR 7 | Windows 11 | ? | ? | ? | ? | — | — |

## Their writer → our reader

| Tool | OS | Result | Notes |
|---|---|:---:|---|
| 7-Zip 24.x | Ubuntu 24 | CI | writes AE-1 by default |
| 7-Zip 24.x | macOS 15 | CI | writes AE-1 by default |
| 7-Zip 24.x | Windows 11 | CI | writes AE-1 by default |

## Completion

Once all `?` cells are filled:
- If all pass → remove the `⚠️ Interop validation pending` block from `packages/as-zip/README.md`.
- If any tool rejects → file a follow-up issue for `vendorVersion?: 'AE-1' | 'AE-2'`.
