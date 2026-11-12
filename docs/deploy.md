# Deploying the Worker

The Worker runs in the Cloudflare account whose data it backs up, so the data and the key never
pass through anyone else. It needs Workers Paid: a backup step needs minutes of CPU, and Workflows
on Free get 10 ms a step.

Run these from `apps/worker`, logged in with `npx wrangler login`.

## 1. The key

```sh
pnpm keygen
```

prints a new master key. Put it in a password manager **before anything else**. Every backup is
sealed with it, and without it none of them opens: nobody, Gateweave included, can recover it.

## 2. The bucket and the catalog

```sh
npx wrangler r2 bucket create gateweave-backup
npx wrangler d1 create gateweave-backup
```

Put the catalog's `database_id` in `wrangler.jsonc`, then make its tables:

```sh
npx wrangler d1 migrations apply gateweave-backup --remote
```

Lock the bucket, so that nothing can delete or overwrite a backup for 30 days: not a mistake, not a
bad deploy, and not someone who gets hold of a token.

```sh
npx wrangler r2 bucket lock add gateweave-backup keep-30-days "" --retention-days 30
```

Retention still runs under a lock. What it would delete before the lock allows is left for a later
run, and the catalog counts it as held.

## 3. The sources

Each D1 database to back up gets a binding in `d1_databases` and an entry in `SOURCES`:

```jsonc
"d1_databases": [
	{ "binding": "CATALOG", "database_name": "gateweave-backup", "database_id": "…", "migrations_dir": "migrations" },
	{ "binding": "TRACK_DB", "database_name": "gateweave-track", "database_id": "…" }
],
"vars": {
	"SOURCES": [{ "name": "track", "kind": "d1", "binding": "TRACK_DB" }]
}
```

A source's `name` is its folder in the bucket. Choose it once: a new name starts a new repository.

### An app's Durable Objects

An app that offers a `Backup` entrypoint, as Track does, gets a service binding to it and a source
of kind `do`. The app must be a Worker in the same account:

```jsonc
"services": [{ "binding": "TRACK_APP", "service": "gateweave-track", "entrypoint": "Backup" }],
"vars": {
	"SOURCES": [
		{ "name": "track", "kind": "d1", "binding": "TRACK_DB" },
		{ "name": "track-workspaces", "kind": "do", "binding": "TRACK_APP" }
	]
}
```

The app says which objects there are; Track lists its workspaces. Each night's snapshot holds a
dump per object, under its name, and stores only the dumps that changed.

### An R2 bucket

A bucket gets an R2 binding and a source of kind `r2`. Each night's snapshot holds every object,
with its metadata, and reads only the objects that are new or were replaced since the last one:

```jsonc
"r2_buckets": [
	{ "binding": "VAULT", "bucket_name": "gateweave-backup" },
	{ "binding": "TRACK_FILES", "bucket_name": "gateweave-track-files" }
],
"vars": {
	"SOURCES": [{ "name": "track-files", "kind": "r2", "binding": "TRACK_FILES" }]
}
```

The binding needs only to read, but Workers bindings can't be made read-only: the backup lists and
gets, and never writes there. `VAULT` itself can't be a source.

## 4. Deploy and set the key

```sh
npx wrangler deploy
npx wrangler secret put BACKUP_KEY
```

and paste the key when asked. Backups run every night at 03:17 UTC (`schedules` in
`wrangler.jsonc`).

## 5. Run one now, and check it

```sh
npx wrangler workflows trigger gateweave-backup '{"sources":["track"]}'
npx wrangler workflows instances describe gateweave-backup latest
npx wrangler d1 execute gateweave-backup --remote \
  --command "SELECT source, status, snapshot, row_count, error FROM run ORDER BY started_at DESC LIMIT 5"
```

A run with no `sources` backs up all of them. One that fails says why in the catalog's `error`,
which names objects and steps, never data.

## Restore tests

Every `RESTORE_TEST_DAYS` days (30 by default), a run restores the snapshot it has just made into a
Durable Object's SQLite, counts every table against the dump, and rolls the rows back, so no copy
stays there. The first run of a source tests it, and a test that fails is tried again the next
night. The deploy makes the Durable Object (`exports` in `wrangler.jsonc`).

Set `JURISDICTION` to the bucket's jurisdiction (`"eu"` or `"fedramp"`), so restore tests run there
too. To test now, add `"test": true` to a run, and read the outcome in the catalog:

```sh
npx wrangler workflows trigger gateweave-backup '{"sources":["track"],"test":true}'
npx wrangler d1 execute gateweave-backup --remote \
  --command "SELECT source, snapshot, status, row_count, error FROM restore_test ORDER BY tested_at DESC LIMIT 5"
```

A failed test fails the run, but the backup it tested stays.

## Alerts

A run in which a backup or a restore test failed sends an alert, and so does the daily check
(`triggers` in `wrangler.jsonc`, at 09:17 UTC) when a source's newest backup started over 26 hours
ago, or hasn't ended after 5. The check counts on backups running every night. Every alert is kept
in the catalog's `alert` table, sent or not; set up where they go, by email, by webhook or both.

**Email** needs [Email Service](https://developers.cloudflare.com/email-service/) sending from a
domain of yours (`npx wrangler email sending enable example.com`). Add the binding and the sender
to `wrangler.jsonc`:

```jsonc
"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["backup@example.com"] }],
"vars": { "ALERT_FROM": "Backups <backup@example.com>" }
```

and give where alerts go as a secret, so no address is in the repository: one or several,
separated by commas.

```sh
npx wrangler secret put ALERT_TO
```

**A webhook** gets a POST of JSON, `{"type":"backup.alert","timestamp":…,"data":{"key","subject","text"}}`,
signed as [Standard Webhooks](https://www.standardwebhooks.com) signs one, so its libraries check
it. Set two secrets: `ALERT_WEBHOOK_URL`, an https address, and `ALERT_WEBHOOK_SECRET`, at least 24
random bytes in base64 (`whsec_` in front or not). `webhook-id` is the same each time an alert is
sent, so the receiver can drop a second copy.

A setting that is there but wrong stops alerts, not backups, and the catalog says which. To check
that alerts arrive, add `"alert": true` to a run, which sends one even if nothing failed:

```sh
npx wrangler workflows trigger gateweave-backup '{"sources":["track"],"alert":true}'
npx wrangler d1 execute gateweave-backup --remote \
  --command "SELECT key, subject, sent_to, sent_at, error FROM alert ORDER BY made_at DESC LIMIT 5"
```

`sent_to` lists where it went; it is empty when nothing is set up. An alert that couldn't go keeps
its `error`, and the daily check sends it again for three days.

## Retention

`RETENTION` keeps the newest snapshot, the newest of each of the last 7 days, 4 weeks and 12 months
(`1l 7d 4w 12m`). [format.md](format.md#retention) says exactly how it counts.

## Restoring

[restore.md](restore.md): the CLI reads the bucket with a read-only R2 token and the key, and
writes SQL for a new D1 database, or a bucket's objects to a folder.

## What it can't do yet

- D1, an app's Durable Objects and R2 buckets. KV comes next.
- A bucket's backup takes a Workflow step per 1,000 objects listed and per 100 objects or 256 MB
  read, so the first backup of a bucket of hundreds of thousands of objects takes too many steps
  for one run. Later runs read only what is new.
- One copy, in R2. The copy at another provider comes next.
- A database whose rows come to more than 12 million characters is read a page at a time (see
  [Core](architecture.md#core)). One that changes during each of three tries is kept anyway, and
  says it wasn't read at one moment. A table that large without a rowid (`WITHOUT ROWID`) can't be
  read a page at a time, and its backup fails.
- A restore test holds the dump in memory once, as it was stored, while it loads. On Cloudflare a
  test of a 160 MB dump passed and one of 240 MB ran out of the Durable Object's memory (measured
  2026-11-12), so larger databases will need a test that restores them in parts.
