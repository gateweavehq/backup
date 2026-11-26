# Contributing to Gateweave Backup

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request. Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

Open an issue before anything large, and before anything that touches the repository format: say
what you have in mind, so nobody does it twice and the design is agreed before the work. Small
fixes, to the code or the documentation, can come straight as a pull request.

Issues labelled [good first issue](https://github.com/gateweavehq/backup/labels/good%20first%20issue)
are small: [see the open ones](https://github.com/gateweavehq/backup/issues?q=is%3Aopen+label%3A%22good+first+issue%22).
Say in the issue that you're taking one.

## Setup

You need Node.js 24 (see `.node-version`; 22.13 or later works) and pnpm 12. Nothing else: the
tests run the Worker in workerd on your machine, with local stand-ins for D1, R2, Durable Objects
and Workflows, and need no Cloudflare account.

```sh
pnpm install
pnpm verify      # Biome check, typecheck and every test: what CI runs
```

See the [README](README.md) for what Backup does, [docs/architecture.md](docs/architecture.md)
for how it fits together, and [docs/format.md](docs/format.md) before touching anything that
reads or writes a repository.

## Contributor License Agreement

Gateweave Backup is open source under the AGPL-3.0. The maintainer also offers it under other
terms, such as a hosted service and commercial licenses, and these help fund the project. So that
every contribution can be part of both, contributors sign the [CLA](CLA.md) once, and it covers
every Gateweave project. You keep the copyright to your work.

A bot asks you to sign on your first pull request. To sign, reply with the sentence it gives you.

## Before you open a pull request

```sh
pnpm verify
```

`pnpm format` fixes most Biome findings. While iterating, scope a command to one package, for
example `pnpm --filter @gateweave/backup-core test`.

Fill in the pull request template: it asks how you tested the change and what a deployment has to
do when it takes it. You don't need to edit `CHANGELOG.md`; it is written when a version is
released.

## Guidelines

- **Keep changes focused.** One pull request should cover one concern.
- **The format is a contract.** [docs/format.md](docs/format.md) describes every object a
  repository holds. A change to it is a new format version, never an edit to version 1, and the
  test that reads a repository made by earlier code must keep passing as it is.
- **Nothing leaves memory unsealed.** No path may write the master key, a derived key or a
  plaintext chunk anywhere, and an error names objects, never their contents.
- **Never restore over live data.** The CLI only reads a repository, and writes only files and
  objects that aren't there yet.
- **Test behaviour, not implementation.** The Worker's tests run a real Workflow against real D1,
  R2 and Durable Objects in workerd (`apps/worker/test`); the CLI's run the CLI against a
  repository in a folder and behind a stand-in S3 server. Add a test for every bug fix.
- **The catalog's schema changes by migration.** Add a file to `apps/worker/migrations`. Never
  edit one that has been merged.
- **Match the surrounding code.** Biome enforces formatting. For everything else, follow the
  conventions of the file you are editing.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`. Add a scope when it helps, for example
`fix(cli): refuse a key that can't be a path`. Say why in the body.

## Contributing with agents

You are welcome to work with coding agents. The
[community rules](https://docs.gateweave.com/community-rules/) apply to people and the agents they
work with:

- Before you or your agent start work on an issue, claim it. [Where to start](#where-to-start) says
  how. An account, meaning a person and their agents, holds one open claim in this repository, or
  three after its first pull request merged here. A claim lapses after 7 days unless a pull
  request of yours that mentions the issue is open or merged.
- The person who opens a pull request answers for it.
- Agents never vote, moderate or sign the [CLA](#contributor-license-agreement).
- The pull request template asks which agent helped, if any. That is for disclosure only.

[AGENTS.md](AGENTS.md) gives agents the project's commands,
invariants and conventions. You remain responsible for the change: review it, run `pnpm verify`,
and make sure you can explain it in review. Commits carry no AI attribution.

## Reporting bugs

Open an issue using the bug report form: the steps to reproduce, what you expected, and what
happened. Never paste a backup key, a token or data from a backup. Report security problems
privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.
