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

| Piece           | What it does                                                            |
| --------------- | ----------------------------------------------------------------------- |
| `packages/core` | The format: keys, sealing, chunking, repositories, SQLite dumps         |
| `apps/worker`   | Schedules, sources and destinations, the catalog, alerts, restore tests |
| `packages/cli`  | Reads a repository with the key and writes the files back               |

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

### Worker

[deploy.md](deploy.md) says how to set it up. Today it backs up D1 into one R2 bucket, with the
catalog, the lock and retention; the rest of this section is still to come where it says so.

- **Runs in the owner's own Cloudflare account,** through the Deploy button, so the data and the
  key never pass through Gateweave. A hosted version would hold a token for every customer's
  account. That makes it a target, so it comes later, if at all.
- **Sources through bindings,** not API tokens: a D1 binding per database, an R2 binding per bucket,
  a KV binding per namespace, and an RPC binding (`backup()`) for a Durable Object app that offers
  one. Track, Agents and Mail will offer one first.
- **Cloudflare Workflows** run each backup, one source after another: start, lock, back up, record,
  prune, test when due, finish. Steps are durable and retried, so a run that stops resumes at the step it was on,
  and a failed source doesn't stop the others. The Workflow's own `schedules` start a run each night;
  `wrangler workflows trigger` starts one by hand.
- **A D1 catalog** of runs, snapshots, locks and restore tests feeds the page, the alerts and
  MCP. It describes the bucket and never replaces it.
- **A lock per source.** Pruning deletes the chunks no manifest names, so it must never meet a run
  that has found a chunk stored and not yet written its manifest. A run takes the source's lock
  before its first write and gives it back after its last; one that dies frees it after 12 hours.
  The Workflow also runs one instance at a time, but scheduled instances may start past that limit.
- **Retention:** the newest snapshot, then 7 daily, 4 weekly and 12 monthly by default. Pruning
  forgets manifests first, then deletes the chunks nothing points to. The snapshot a run just made
  always stays.
- **Restore tests.** A run restores the snapshot it made when the source's last passed test is
  `RESTORE_TEST_DAYS` old (30 by default) or it has none, so a failed one is tried again the next
  night. A Durable Object, one per source, reads every file back and checks it, makes the dump's
  tables in its own SQLite, loads the rows in one transaction, checks foreign keys, counts every
  table against the dump, and rolls the rows back. It runs after the prune and under the lock, so
  it also proves the prune kept what the snapshot needs. A failed test fails the run but keeps the
  backup, and the catalog says why.
- **A restore test keeps no copy.** Only the empty tables are ever committed, and they are deleted
  at the end. The 30 days of point-in-time recovery a Durable Object's storage keeps go back only to
  committed states, so they never hold a row. After the rollback the test checks that every table
  is empty again. The rows can't go in with the tables: rolling back writes to an FTS5 table made in
  the same transaction crashed workerd when we tried it. `JURISDICTION` keeps the objects where the
  bucket is. An object runs one test at a time, since a step that timed out may be tried again
  while its first try is still running.
- **Alerts.** A run in which a backup or a restore test failed ends with an alert, and so does
  one that asks for it (`"alert": true`). The Worker's own cron checks each morning, six hours after
  the nightly run, that every source's newest backup started in the last 26 hours and hasn't been
  going for over 5, and alerts if not: that catches the runs that never got far enough to send their
  own. An alert goes by email through Email Service's binding and to a webhook signed as Standard
  Webhooks signs one, whichever are set up. It is written to the catalog under its key
  (`run:<instance>` or `late:<day>`) before it is sent and marked when it has gone, so a retried step
  doesn't send it twice. One that can't be sent stays there with why, the run ends as it would have,
  and the morning check tries it again for three days. Its text names sources, snapshots and steps,
  never data, like the catalog's errors. Opening a Track issue can come through the webhook.
- **MCP (next):** agents can list and check backups. A restore needs a person.

### CLI

[restore.md](restore.md) says how to use it.

- **One file, Node only.** It bundles the format's code, so a restore needs Node.js and that file,
  nothing from Gateweave. It signs S3 requests itself (SigV4) rather than pulling in an SDK.
- **Reads only.** The stores it opens refuse every write, so no mistake in it, and no token with more
  rights than it needs, can change a backup.
- **Writes only new files.** A restore goes to a folder: SQL for a new D1 database, a SQLite file, or
  the files as stored. Each file is written under a name of its own (`<name>.partial-<random>`),
  checked for its size, then given its name with a hard link, which refuses a name that is taken
  where a rename would replace it. So a restore that fails or is stopped leaves nothing that looks
  finished.
- **Checks by restoring.** `check` restores each database into memory and counts its rows against
  the dump, which proves more than reading the bytes.

## Decisions

- **Our own format, not restic's.** restic's format would let its CLI read our backups, but its
  sealing (AES-CTR with Poly1305-AES) and its index files need more code in a Worker than they give
  back. A short, documented format and our own restore CLI keep the promise in principle 1.
- **JSON lines for SQLite, not SQL text.** A line can't be split by a value with a line break in it,
  and the restore can check what it reads, including that the dump ended.
- **Restore tests in a Durable Object, not in memory.** A WebAssembly SQLite in the Worker would
  keep everything in memory, but it isn't the SQLite D1 runs, with D1's limits. A Durable Object's
  is, so a statement D1 would refuse fails the test too, and rolling the rows back keeps the data out
  of its storage.
- **One consistent read where possible.** D1's batch is a transaction, so a dump that fits in one
  batch is a true snapshot. Larger databases will need a paged mode, which says it isn't one.
