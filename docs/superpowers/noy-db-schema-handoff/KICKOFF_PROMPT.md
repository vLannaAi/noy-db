# Claude Code kickoff prompt

Copy everything between the `---` markers into a Claude Code session
started inside the noy-db repo root. The prompt assumes you have:

- `gh` CLI authenticated with write access to `vLannaAi/noy-db`
- The handoff bundle (`BRIEF.md`, `RATIONALE.md`, `create-schema-milestone.sh`, `vault.example.noydb.yaml`) accessible — either dropped into a scratch dir inside the repo, or in a sibling directory you can reference.

---

I'm starting work on a new declarative schema layer for noy-db. The
design decisions are already made — they're captured in a handoff
bundle I've placed alongside the repo (or inside it; check both).

**Step 1 — Read the handoff bundle.**

Locate and read these files (try `./schema-handoff/`, `../schema-handoff/`,
or wherever they ended up):

- `BRIEF.md` — settled design decisions. Do not relitigate these.
- `RATIONALE.md` — why those decisions. Read for context, not for
  re-debate.
- `create-schema-milestone.sh` — milestone + 8 issue bodies.
- `vault.example.noydb.yaml` — sketch of the YAML format.

**Step 2 — Read the repo.**

Read these to understand what we're integrating with:

- `README.md`
- `SPEC.md`
- `SUBSYSTEMS.md`
- `features.yaml`
- `package.json`, `pnpm-workspace.yaml`, `turbo.json` (monorepo layout)
- `packages/hub/` — at least the public API surface
- One showcase, preferably `showcases/` for an accounting-app-shaped one,
  to see how collections and validation are wired today

**Step 3 — Confirm the plan back to me.**

Before doing anything, summarize:

- What package directory you'll create
- What the eight issues are (titles only)
- What you propose to commit in the first PR
- Any conflicts you see between the brief and the current repo
  structure

Wait for me to say "go" before any writes or `gh` commands.

**Step 4 — On my "go":**

1. Run `bash create-schema-milestone.sh --dry-run`. Show me the output.
2. After I confirm again, run it for real.
3. Create the `feat/schema` branch from `main`.
4. Scaffold `packages/schema/` with the public API from BRIEF.md.
   Leave function bodies as `throw new Error('not implemented')` with
   a TODO comment referencing the relevant issue number. Commit.
5. Copy `vault.example.noydb.yaml` into `docs/schema/examples/accounting-app.vault.noydb.yaml`
   and adapt it to whatever the accounting-app showcase actually looks
   like in the repo. This is the design artifact for issue #1. Commit
   on a separate PR-ready branch off `feat/schema`.
6. Draft `docs/adr/0001-schema-format.md` covering the YAML + JSON
   decision per RATIONALE.md. Commit.

**Step 5 — Stop and check in.**

Don't start on issues #2–#8 in this session. Open the first three PRs
into `feat/schema`, summarize what landed, and wait for review.

**Rules:**

- Don't invent scope beyond what's in BRIEF.md. If something feels
  missing, ask before adding it.
- Don't touch `main` directly. Everything goes through `feat/schema`.
- Don't add labels that don't already exist on the repo. If
  `create-schema-milestone.sh` references missing labels, either
  create them with `gh label create` (ask first) or strip them from
  the script.
- Keep commit messages tight and conventional (`feat(schema): scaffold package`).
- If you find a real conflict between the brief and the current repo
  (e.g. a package name collision), stop and ask. Don't paper over it.
