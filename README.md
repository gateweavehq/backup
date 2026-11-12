# Gateweave Backup

Scheduled, encrypted backups of what your app keeps on Cloudflare: D1 databases, Durable Objects'
SQLite, R2 buckets and KV. A copy goes outside Cloudflare, and every month a restore proves the
backups work.

It is early. Today it backs up D1 databases, the Durable Objects of an app that offers them, and R2
buckets, every night into an R2 bucket:

- data is sealed with AES-256-GCM before it leaves, under a key only you hold;
- content-defined chunking, so a nightly backup stores only what changed;
- exact SQLite dumps of D1 and Durable Object databases, full-text search indexes included;
- every object of an R2 bucket with its metadata, reading only the objects that are new;
- a Worker in your own account runs it on Cloudflare Workflows, keeps a catalog of runs and
  snapshots, and keeps 7 daily, 4 weekly and 12 monthly snapshots;
- every 30 days a restore test reads a new snapshot back, restores it into SQLite and counts every
  table, keeping none of it;
- each run can copy the sealed backups to an S3-compatible bucket at another provider, which keeps
  them under the same retention;
- a failed, late or stuck backup sends an alert by email, to a signed webhook, or both;
- a restore CLI, one file for Node, reads the bucket with the key alone and writes SQL for a new D1
  database or a SQLite file, or puts a bucket's objects back with their metadata, never over
  anything.

KV sources come next. See [docs/deploy.md](docs/deploy.md), [docs/restore.md](docs/restore.md),
[docs/architecture.md](docs/architecture.md) and [docs/format.md](docs/format.md).

## License

[AGPL-3.0](LICENSE).
