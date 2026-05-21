# noy-db schema layer — Claude Code handoff bundle

This bundle is the work-in-progress carry-over from a chat-based design
conversation. It contains everything needed to pick up work on a new
declarative schema layer for noy-db without losing the prior context.

## What this is

A design and kickoff package for a new `@noy-db/schema` package and the
`feat/schema` long-running branch. The schema layer will let users
describe a vault's shape (collections, fields, validation, FKs, MVs,
overlay views, ACLs, i18n) in a portable YAML/JSON format. It enables:

- Introspection of live vaults
- Static consistency checks
- Diagram generation
- Round-trip editing via external tools (Mermaid, drawio, custom viewer)
- TypeScript codegen

## Files in this bundle

| File                          | Purpose                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `README.md`                   | This file. Orientation for whoever picks up the work.                         |
| `BRIEF.md`                    | Design decisions already made. Don't relitigate these — they're settled.      |
| `RATIONALE.md`                | Why those decisions, with the alternatives that were considered and rejected. |
| `KICKOFF_PROMPT.md`           | Copy-paste prompt for starting a Claude Code session.                         |
| `create-schema-milestone.sh`  | `gh` CLI script that creates the milestone and 8 issues on the GitHub repo.   |
| `vault.example.noydb.yaml`    | Sketch of the YAML format for the accounting-app recipe. Design artifact for issue #1. |

## How to use

1. **Drop these into a scratch directory** (not the repo yet). They're a
   working set, not part of the codebase.
2. **Read `BRIEF.md` first.** Five minutes. It captures every decision
   already made so you don't waste time re-deciding.
3. **Skim `RATIONALE.md`** if you want to know why. Optional but useful
   when adopters or contributors ask.
4. **Open Claude Code in the noy-db repo** and paste `KICKOFF_PROMPT.md`.
   It will read the repo, run the script, create the branch, scaffold
   the package, and draft the first artifact.
5. **Run `create-schema-milestone.sh --dry-run`** first to see what it
   would do. Then run it for real to create the milestone and 8 issues.

## Scope reminder

**v0.1 is declarative shape only.** Storage backend, unlock method,
framework binding, transport, and export format selection are *runtime
configuration* and remain out of scope for the schema layer.

The schema layer is read-only with respect to existing noy-db code:
it describes what exists; it doesn't change how anything runs.

## Status

- [ ] Milestone and issues created on GitHub
- [ ] `feat/schema` branch opened
- [ ] `packages/schema/` scaffolded
- [ ] ADR for format choice drafted (issue #1)
- [ ] Accounting-app recipe expressed in YAML (issue #1)
- [ ] JSON Schema published (issue #1)
- [ ] Zod embedding ADR drafted (issue #2)
- [ ] Parser + validator implemented (issues #3, #4)
- [ ] Introspection API implemented (issue #5)
- [ ] CLI commands implemented (issue #6)
- [ ] Codegen implemented (issue #7)
- [ ] Docs and migration guide (issue #8)
