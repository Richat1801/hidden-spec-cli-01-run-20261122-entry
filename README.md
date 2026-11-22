# mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Node 22](https://img.shields.io/badge/node-22-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

mend, one patch tool for every AI edit format: a Node 22 stdlib-only CLI that
applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a
tree of text files, to the specification in `SPEC.md` — three-tier line
matching (exact, trailing-whitespace, indentation), all-or-nothing writes, and
exact output wording and exit codes. Practice score 1000/1000 (100/100 checks:
unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15).

Run it as `node main.ts [options] [PATCH]`; check it with
`node check.ts ../program/generator/practice.json` from the kit.

- Bounty: [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
- Referral: https://make.fun/r/dss38k9p
