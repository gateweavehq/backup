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

## Retention

`RETENTION` keeps the newest snapshot, the newest of each of the last 7 days, 4 weeks and 12 months
(`1l 7d 4w 12m`). [format.md](format.md#retention) says exactly how it counts.

## What it can't do yet

- Only D1 sources. Durable Objects, R2 and KV come next.
- One copy, in R2. The copy at another provider comes next.
- No restore command yet. Until there is one, a restore is `Repository.readWholeFile` and
  `restoreSql` from `packages/core`, into a new database, never over the live one.
- A database is read in one D1 batch, which must fit in one response. Very large databases will need
  a paged mode.
