# Deferred

Design questions that were reasoned about, deliberately **not** acted on, and
are worth re-reading before someone reasons about them again from scratch.

This is not a backlog. Work that is actually wanted is tracked as GitHub issues
and milestones — that is the only place scheduled work lives. What is here is
the residue: proposals that need a decision before they could become work, and
scope notes whose *reasoning* outlives the feature that produced them.

## What belongs here

- A proposal that would change something load-bearing and is parked pending an
  explicit decision.
- A deferral whose **reason** is the valuable part — "we chose not to, and here
  is what it would cost" — where re-deriving the reason would take real effort.
- An open question that has no owner and no consumer waiting on it, but that
  will be asked again.

## What does not

- Anything with a live consumer or a committed date. That is an issue.
- Deferrals that were simply "not this slice" and got picked up later. Those are
  release history; git has them.
- Feature documentation of any kind. That lives in
  [noy-db-docs](https://github.com/vLannaAi/noy-db-docs).

## The rule for removing a page

A page leaves this folder in exactly two ways: the decision gets made and the
work becomes an issue, or the question stops mattering and the page is deleted
with a line in the commit message saying why. Silently letting it rot is how the
folder becomes another archive.

## Contents

- [`encryption-boundary-flip.md`](encryption-boundary-flip.md) — a standing
  proposal to move the encryption boundary. Highest-stakes item here.
- [`query-and-view-backlog.md`](query-and-view-backlog.md) — deferred query DSL,
  materialized-view, and guard capabilities, with the reason each was cut.
- [`storage-and-debug-questions.md`](storage-and-debug-questions.md) — unresolved
  questions in object-projection, debug/plaintext mode, and schema tooling.
