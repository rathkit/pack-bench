# Contributing to Rathkit Pack benchmarks

**Report problems with the benchmarks as an issue in [rathkit/pack](https://github.com/rathkit/pack) (label `benchmarks`).**
Issues and pull requests are turned off in this repository, and pull requests from outside are not taken.
Only the owner pushes here. This page says how a change is made and what it has to show.

Read the [Code of Conduct](CODE_OF_CONDUCT.md) and the [AI policy](AI_POLICY.md) first. Roles are in
[GOVERNANCE.md](GOVERNANCE.md) and [MEMBERS.md](MEMBERS.md).

## Changing the benchmark

- A change to a tool's options or version needs a reason, a full container run, and the before and after
  tables in the commit message or in the issue that asked for it.
- A benchmark runs only through `container/run.sh`. Figures from CI, from a working tree, or from the host
  are never accepted and never published.
- Pinned versions and digests move together with a rerun. A version bump changes the figures.
- Published figures live in `published/`, one results file per table, and in Pack's `docs/benchmarks.md`.

## Commits

- `type(scope): subject`, in the Conventional Commits style. Types: `feat`, `fix`, `docs`, `test`, `perf`,
  `refactor`, `chore`, `ci`, `build`, `style`. Imperative, lower case after the colon, no trailing period.
- The body explains why, not what. Write in American English.
- Every commit is signed with a verified GPG key and carries a DCO sign-off (`git commit -s -S`). No other
  trailers. See the [AI policy](AI_POLICY.md).

## What we do not take

- Runtime dependencies in Pack. This repository holds the compared tools; Pack stays at zero.
- Code copied from another project unless its license allows it.
- Changes that skip signing or the sign-off.

## Security

Follow [SECURITY.md](SECURITY.md).

## License

By contributing you certify the [DCO](DCO) and agree that your contribution is licensed under Apache-2.0
(see [LICENSE](LICENSE)). The copyright holder is named in [NOTICE](NOTICE).
