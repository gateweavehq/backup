# Architecture

Gateweave Backup keeps copies of what an app on Cloudflare stores (D1 databases, Durable Objects'
SQLite, R2 buckets, KV) somewhere a mistake, a bad deploy or a lost account can't reach. It
encrypts them before they leave, keeps them under a retention policy, and tests that they restore.

## Why it exists

Cloudflare's own recovery is good for going back a few days in place, and nothing more:

- D1 Time Travel goes back 30 days (7 on Free) and restores **in place**, overwriting the database.
  It can't copy to a new database yet.
- A Durable Object's SQLite has the same 30 days, also in place, and no export.
- R2 has no point-in-time recovery: a deleted object is gone. Bucket locks can stop deletes for a
  while.
- KV has nothing.

None of it survives the account itself being lost or misused, and none of it is tested until the
day it's needed. The open-source tools we found each cover one piece, mostly a D1 dump into R2 in
the same account.

## Principles

1. **A restore never needs us.** The format is documented ([format.md](format.md)), and the key and
   the objects are enough to read it. A small CLI does it without any Gateweave service.
2. **The key stays with the owner.** Data is sealed before it is written. The Worker holds the key
   as a secret, and nothing else holds it.
3. **One copy outside Cloudflare.** The 3-2-1 rule: three copies, on two kinds of storage, one
   elsewhere. A locked R2 bucket plus an S3-compatible bucket at another provider.
4. **Never restore over live data.** A restore goes to a new database or bucket, with a preview of
   what is in it.
5. **A backup that wasn't restored isn't known to work.** A monthly restore test is part of the
   product, and its date is shown next to every source.

## Pieces

| Piece                | What it does                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/core`      | The format: keys, sealing, chunking, repositories, SQLite dumps         |
| `apps/worker` (next) | Schedules, sources and destinations, the catalog, alerts, restore tests |
| A restore CLI (next) | Reads a repository with the key and writes the files back               |

### Core

- **Sealing:** AES-256-GCM, with keys derived from the owner's master key by HKDF and salted with
  the repository's id. Each blob's label (what it is and its name) is authenticated, so a blob moved
  to another name doesn't open.
- **Chunking:** FastCDC with a keyed gear table. Cuts depend on content, so a nightly dump that
  changed in a few places stores only a few new chunks. Chunks are named by an HMAC of their
  plaintext, so the same data is stored once without revealing its hash.
- **SQLite dumps:** one JSON line per table, row and object, built from SQLite's own `quote()`, so
  every value comes back exactly. A dump reads its rows in one consistent read: a D1 batch is one
  transaction, and a Durable Object's storage is synchronous. Virtual tables are handled: FTS5
  indexes over another table are rebuilt, FTS5 tables that keep their own text are copied with
  their rowids, and contentless ones are reported as coming back empty.

### Worker (next)

- **Runs in the owner's own Cloudflare account,** through the Deploy button, so the data and the
  key never pass through Gateweave. A hosted version would hold a token for every customer's
  account. That makes it a target, so it comes later, if at all.
- **Sources through bindings,** not API tokens: a D1 binding per database, an R2 binding per bucket,
  a KV binding per namespace, and an RPC binding (`backup()`) for a Durable Object app that offers
  one. Track, Agents and Mail will offer one first.
- **Cloudflare Workflows** run each backup. Steps are durable and retried, and a large export can
  resume where it stopped. Cron Triggers start them.
- **A D1 catalog** of sources, runs, snapshots and restore tests feeds the page, the alerts and MCP.
- **Retention:** 7 daily, 4 weekly and 12 monthly snapshots by default. Pruning deletes manifests
  first, then chunks nothing points to.
- **Alerts:** a failed or late backup sends mail, opens a Track issue or calls a webhook.
- **MCP:** agents can list and check backups. A restore needs a person.

## Decisions

- **Our own format, not restic's.** restic's format would let its CLI read our backups, but its
  sealing (AES-CTR with Poly1305-AES) and its index files need more code in a Worker than they give
  back. A short, documented format and our own restore CLI keep the promise in principle 1.
- **JSON lines for SQLite, not SQL text.** A line can't be split by a value with a line break in it,
  and the restore can check what it reads, including that the dump ended.
- **One consistent read where possible.** D1's batch is a transaction, so a dump that fits in one
  batch is a true snapshot. Larger databases will need a paged mode, which says it isn't one.
