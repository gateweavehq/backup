# Restoring

A restore needs three things: the master key, the repository's objects, and the CLI in
`packages/cli`. Nothing else: no Gateweave service, no Worker, not even Cloudflare if you have a
copy of the objects elsewhere.

A restore never goes over live data. The CLI writes only new files, into a folder you name, and you
load them into a **new** database. A bucket's objects can go straight back into a bucket, but only
where their keys are free. It only reads the repository, whatever its credentials allow.

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
against its SHA-256, then restores each database in it into memory and counts its rows against the
dump.
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

## Restore an app's Durable Objects

A snapshot of an app's Durable Objects, such as Track's workspaces, holds a database per object.
`show` lists them, and `--object <name>` shows one's tables. `restore` writes `<object>.sql` for each
object, or `<object>.sqlite` with `--as sqlite`; `--object` restores only the one it names:

```sh
node gateweave-backup.mjs show s3://gateweave-backup/track-workspaces latest
node gateweave-backup.mjs restore s3://gateweave-backup/track-workspaces latest --to ./restore --as sqlite --object <workspace id>
```

Each file is one object's database. Read it with `sqlite3`, or load the SQL into a new D1 database
to look at it. Putting it back into the live app's object is the app's to offer; Track doesn't yet.

## Restore an R2 bucket's objects

A snapshot of a bucket, such as Track's files, holds every object's bytes and `bucket.json`, which
lists them with their metadata ([format.md](format.md#manifests)).

**Into the bucket.** `--to s3://<bucket>` puts the objects back, each under its key with its type,
its other HTTP metadata and its custom metadata. An object goes in only where its key is free: every
upload carries `If-None-Match: *`, so the bucket refuses one whose key is taken, and nothing in it is
ever replaced. That makes it safe to aim at the live bucket, which gets back what is missing and
keeps the rest as it is.

Pick what comes back with `--prefix`. Track keeps a workspace's files under `<workspace id>/`, so
this brings back one workspace's files and leaves alone the ones people deleted elsewhere:

```sh
export GATEWEAVE_RESTORE_ENDPOINT_URL=https://<account id>.eu.r2.cloudflarestorage.com
export GATEWEAVE_RESTORE_ACCESS_KEY_ID=…
export GATEWEAVE_RESTORE_SECRET_ACCESS_KEY=…
node gateweave-backup.mjs restore s3://gateweave-backup/track-files latest \
  --to s3://gateweave-track-files-eu --prefix "<workspace id>/"
```

The bucket takes a second R2 API token, one with **Object Read & Write** for that bucket alone, in
the `GATEWEAVE_RESTORE_*` variables, so the token that reads the backup can stay read-only. Without
them the `AWS_*` ones are used, which suits a restore from a copy on disk. `--to-endpoint` and
`--to-region` stand in for the endpoint and region. Gateweave Cloud's bucket for Track's files is
in the `eu` jurisdiction, so its endpoint has `.eu` after the account id; a bucket outside a
jurisdiction has none.

The CLI says each key it puts back and each it leaves, then counts them. Each object is read and
checked as it is sent, and the upload is signed with the object's SHA-256, so the bucket refuses
bytes that don't match it. When a restore stops half way, say on a damaged chunk, the objects put
back so far stay, each one whole, and the same restore run again puts back the rest.

The S3 API keeps custom metadata names in lower case, R2 included: Track's `uploadedBy` comes back
as `uploadedby`, and the CLI says so. Track reads that name only to tell a retried upload from
someone else's, so restored files work as before. Metadata no header can carry, such as a name
outside ASCII, stops the restore before anything is sent; an object over 4.995 GiB, more than one
upload takes at R2, does too.

**Into a folder.** `--to <folder>` writes `bucket.json`, and each object at `files/<key>`.
`--prefix` works here too.

```sh
node gateweave-backup.mjs restore s3://gateweave-backup/track-files latest --to ./restore
```

A key that can't be a path in a folder, such as one with `..` or `//` in it, stops the restore and
says so.

## When it fails

The CLI says what went wrong and names the object, never what is in it:

- **That key doesn't open this repository**: a different key, or a different repository.
- **… could not be opened: the key is wrong, or the object was changed**: an object was damaged
  or changed. Try an older snapshot; `check --all` shows which ones are whole.
- **… is missing**: a chunk is gone, so its snapshot can't be restored whole.
- **… is there already**: the folder has a file of that name. Pick an empty folder.

A file is written as `<name>.partial-<random>` and gets its name only once it is whole. If the CLI
is killed outright, such a file can stay behind: delete it and restore again.

`--key-file` reads a file PowerShell's `>` wrote (UTF-16) as well as plain text.
