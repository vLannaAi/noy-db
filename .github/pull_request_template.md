<!--
Thanks for contributing to NOYDB!

Please target your PR at the right base branch:
- Bug fixes that ship now → main
- v0.3 feature work → v0.3-dev
- Future-release work → the relevant <vX.Y>-dev branch

If your PR is still WIP, open it as a draft.
-->

## Summary

<!-- One paragraph: what changes and why. Lead with the user-facing impact. -->

## Closes

<!--
Link the issue this PR resolves. PRs that don't close an issue should explain why.
For v0.3 work, also link the epic:
  Closes #N
  Part of #1
-->

## Acceptance criteria touched

<!--
Copy the relevant checkboxes from the linked issue and check the ones this PR satisfies.
Leave unchecked the ones being deferred to a follow-up PR (and link the follow-up).
-->

- [ ]
- [ ]

## Test plan

<!--
How was this verified? At minimum:
- Unit tests added / updated (count)
- pnpm turbo lint typecheck test build clean
- Manual verification (steps)
-->

- [ ] Unit tests added / updated
- [ ] `pnpm turbo lint typecheck test build` clean locally
- [ ] Privacy guard clean (`pnpm run guard:privacy`)
- [ ] Changeset added (`pnpm changeset`) if this changes a public package

## Notes for reviewers

<!--
- Decisions you made that aren't obvious from the diff
- Trade-offs you considered
- Anything you're uncertain about and want input on
-->

## Security checklist

<!-- Required for any PR touching packages/core/ or any cryptographic code paths -->

- [ ] No new runtime crypto dependencies introduced (Web Crypto API only)
- [ ] No plaintext leaves the crypto layer
- [ ] No keys persisted to disk or sent over the network
- [ ] No `_iv` reuse (every encrypt operation gets a fresh random 12-byte IV)
- [ ] Adapter receives only encrypted envelopes

<!-- N/A is fine for non-core PRs; please mark explicitly. -->
