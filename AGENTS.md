# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## The project

Gateweave Backup makes scheduled, encrypted backups of Cloudflare data (D1, Durable Objects'
SQLite, R2, KV), keeps a copy outside Cloudflare, and tests its restores. Read
[docs/architecture.md](docs/architecture.md) first, and [docs/format.md](docs/format.md) before
touching anything that reads or writes a repository.

## Repository map

| Path            | What lives there                                             |
| --------------- | ------------------------------------------------------------ |
| `packages/core` | The repository format: keys, sealing, chunking, SQLite dumps |
| `docs/`         | Architecture and the format                                  |

## Commands

Requirements: Node.js 24 (see `.node-version`; 22.13+ works) and pnpm 12.

| Command          | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| `pnpm install`   | Install dependencies                             |
| `pnpm check`     | Biome lint and format (`pnpm format` fixes most) |
| `pnpm typecheck` | Type-check every package                         |
| `pnpm test`      | Run every test suite                             |
| `pnpm verify`    | Everything CI runs                               |

## Invariants

1. **The format is a contract.** docs/format.md describes every object a repository holds. Code
   follows it; a change to it is a new format version, never an edit to version 1.
2. **Old backups always restore.** A test reads repositories made by earlier code. Never weaken it.
3. **The key never leaves the owner's hands.** Nothing writes the master key, a derived key or a
   plaintext chunk anywhere but memory. Errors name objects, never their contents or the key.
4. **Never restore over live data.** Restores write to a new database or bucket.
5. **Sealing is authenticated.** Every blob is AES-GCM with its label in the additional data.
   Never add a path that reads plaintext without opening it.

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- `packages/core` runs in Workers and Node alike: Web Crypto, streams and `TextEncoder` only.
- Prefer `#private` fields, named exports and small modules.
- Comments explain why, not what.
- Dependencies are pinned to exact versions, shared ones in the `catalog:` of `pnpm-workspace.yaml`.

## Testing

- Test behaviour through public APIs. Every bug fix gets a test that fails without it.
- SQLite dump tests run against real SQLite (`node:sqlite`) and restore what they dump.

## Git

- Conventional Commits, explaining why in the body.
- Commits, pull requests and comments carry no AI attribution: no `Co-authored-by` naming an AI, no
  "Generated with" line and no session link.
