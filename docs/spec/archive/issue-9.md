# Issue #9 — nuxi noydb — CLI subcommand extension

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-07
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: nuxt

---

# `nuxi noydb <command>` extension

Part of #6 (v0.3 release).

## Scope

Inside `packages/nuxt/`, register a `nuxi` namespace that exposes ongoing project commands re-using the `create-noy-db` wizard's prompt code paths. Commands: `add`, `rotate`, `verify`, `seed`, `backup`. Files live under `packages/nuxt/src/cli/` and are surfaced via the module's `nuxi` extension hook.

## Why

Once a project is set up, developers need ergonomic ways to add a collection, rotate keys, run the integrity check, re-seed, and back up — without writing scripts. This is the maintenance half of the v0.3 adoption story.

## Technical design

- Use Nuxt 4's `addNuxiCommand` (or the equivalent CLI registration API) from inside the module's `setup()` hook.
- Commands and signatures (from ROADMAP.md "3. `nuxi noydb <command>` extension"):
  - `nuxi noydb add invoices` — scaffold a new collection + Pinia store.
  - `nuxi noydb add user accountant operator` — add a keyring user with role.
  - `nuxi noydb rotate` — interactive key rotation.
  - `nuxi noydb verify` — run the integrity check (open → write → read → decrypt → verify ledger).
  - `nuxi noydb seed` — re-run the project's seeder script.
  - `nuxi noydb backup s3://bucket/backups/` — one-shot encrypted backup.
- Each subcommand imports the same prompt module from `create-noy-db` (workspace dep) — there is one source of truth for the wizard.
- Never asks for AWS credentials interactively; reads them from the standard env / shared credentials chain only.
- All commands are exit-coded so they can be wired into shell scripts.

## Acceptance criteria

- [ ] **Implementation:** `packages/nuxt/src/cli/` with one file per subcommand and an index that registers them.
- [ ] **Unit tests:** `__tests__/cli.test.ts` with at least 10 `it()` blocks: each subcommand parses args correctly, `add` collection scaffolds files into a temp project, `add user` writes keyring, `rotate` no-ops on dry-run flag, `verify` returns 0 on healthy compartment and non-zero on tampered envelope, `backup` rejects unknown URI scheme, secrets never logged, prompts respect `--yes` flag.
- [ ] **Integration tests:** spawn the built CLI inside a Nuxt fixture and assert files are created and `pnpm typecheck` still passes after `add invoices`.
- [ ] **Docs:** README section "CLI commands" listing all six invocations with examples.
- [ ] **Changeset:** patch on `@noy-db/nuxt` (rolled into the same `0.3.0` initial release).
- [ ] **CI:** covered by the existing `nuxt-module-test` job.
- [ ] **Bundle:** CLI code lazy-loaded so it does not bloat the runtime plugin.

## Dependencies

- Blocked by: #2 (the Nuxt module must register the namespace), #1 (shares prompt code with `create-noy-db`)
- Blocks: nothing

## Estimate

M

## Labels

`release: v0.3`, `area: nuxt`, `type: feature`
