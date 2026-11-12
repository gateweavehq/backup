# Restoring

A restore needs three things: the master key, the repository's objects, and the CLI in
`packages/cli`. Nothing else: no Gateweave service, no Worker, not even Cloudflare if you have a
copy of the objects elsewhere.

A restore never goes over live data. The CLI writes only new files, into a folder you name, and you
load them into a **new** database. It only reads the repository, whatever its credentials allow.

## Get the CLI

It is one file that runs on Node.js 22.13 or later:

```sh
pnpm install
pnpm build
node packages/cli/dist/gateweave-backup.mjs --help
```

`packages/cli/dist/gateweave-backup.mjs` can be copied anywhere and run with `node`. Keep a copy
with your key's backup, so a restore doesn't depend on this repository either.

## The key

The CLI reads the key from `GATEWEAVE_BACKUP_KEY`, from a file (`--key-file <file>`), from stdin
when something is piped in, or asks for it without showing it. It never takes the key as an
argument, since shells keep those in their history. Piping it from a password manager works:

```sh
op read "op://Private/Gateweave Backup/key" | node gateweave-backup.mjs snapshots ./track
```

## Reach the repository

Each source has its own repository, in the bucket's folder of the same name (`track`, `id`, …).

**Straight from R2.** Make an R2 API token in the dashboard (R2 object storage › Overview › API
Tokens › Manage) with the **Object Read only** permission, for the backup bucket alone. It gives an
Access Key ID and a Secret Access Key:

```sh
export AWS_ACCESS_KEY_ID=…
export AWS_SECRET_ACCESS_KEY=…
export AWS_ENDPOINT_URL=https://<account id>.r2.cloudflarestorage.com
node gateweave-backup.mjs snapshots s3://gateweave-backup/track
```

A bucket made in a jurisdiction is reached only through that jurisdiction's endpoint:
`https://<account id>.eu.r2.cloudflarestorage.com` for an EU bucket. Gateweave's own bucket is one.

Any other S3-compatible bucket works the same way, with its endpoint and keys, and `--region` (or
`AWS_REGION`) when the provider wants one.

**From a copy.** A folder holding a repository's `config.json`, `snapshots/` and `data/`, as
`rclone copy` or `aws s3 sync` leaves it, is a repository too:

```sh
node gateweave-backup.mjs snapshots ./track
```

## Look before restoring

```sh
node gateweave-backup.mjs snapshots s3://gateweave-backup/track
node gateweave-backup.mjs show s3://gateweave-backup/track latest
```

`show` lists a snapshot's files and, for a database, every table with its row count. It prints
names and counts, never values.

`check` reads a snapshot the way a restore would, checks every chunk against its id and every file
against its SHA-256, then restores the database into memory and counts its rows against the dump.
`check --all` does that for every snapshot. Nothing is written to disk.

```sh
node gateweave-backup.mjs check s3://gateweave-backup/track --all
```

## Restore a D1 database

```sh
node gateweave-backup.mjs restore s3://gateweave-backup/track latest --to ./restore
npx wrangler d1 create track-restored
npx wrangler d1 execute track-restored --remote --file ./restore/database.sql
```

Check the new database, then point the app at it, or copy the rows you need from it. Don't load the
file into the live database: it makes every table, and the live one has them already.

`--as sqlite` writes `database.sqlite` instead, a SQLite file to open with `sqlite3` or any SQLite
tool. `--as files` writes the files the snapshot holds, as they were backed up (`database.jsonl`,
[format.md](format.md#sqlite-dumps) describes it).

## When it fails

The CLI says what went wrong and names the object, never what is in it:

- **That key doesn't open this repository**: a different key, or a different repository.
- **… could not be opened: the key is wrong, or the object was changed**: an object was damaged
  or changed. Try an older snapshot; `check --all` shows which ones are whole.
- **… is missing**: a chunk is gone, so its snapshot can't be restored whole.
- **… is there already**: the folder has a file of that name. Pick an empty folder.
