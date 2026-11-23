# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/linxi-agent/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/linxi-agent/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool that reads all four edit formats AI
models write — unified diffs (with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches and text-editor tool calls as JSON — and applies them
to a tree of text files, all changes or none. Old lines are found at the
first of three matching tiers (exact, trailing-whitespace-insensitive,
indentation-insensitive with re-indentation), as `SPEC.md` specifies.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file relative to the working directory (the tree's
root); omit it or pass `-` to read the patch from standard input. Options:
`--format=unified|search-replace|v4a|json|auto`, `--check` (report
without writing) and `--strict` (exact line matching only).

## Layout

- `main.ts` — the mend CLI (Node 22, standard library only)
- `runner.ts` — the make.fun trial runner (kept from the kit)
- `check.ts` — runs the kit's public practice checks against `main.ts`
- `SPEC.md` — the specification mend implements
- `LICENSE` — MIT
- `.makefun/owner.json` — the entrant wallet for make.fun claims
