# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naufalumer/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naufalumer/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files. It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, full trim with re-indent) and writes every change or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-` (or nothing) to read it from standard input. `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`); the default `auto` detects it. `--check` reports what would change without writing anything. `--strict` matches lines exactly (tier 0 only). See `SPEC.md` for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bye4mn13&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
