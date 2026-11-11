# Gateweave Backup

Scheduled, encrypted backups of what your app keeps on Cloudflare: D1 databases, Durable Objects'
SQLite, R2 buckets and KV. A copy goes outside Cloudflare, and every month a restore proves the
backups work.

It is early. Today it backs up D1 databases every night into an R2 bucket:

- data is sealed with AES-256-GCM before it leaves, under a key only you hold;
- content-defined chunking, so a nightly backup stores only what changed;
- exact SQLite dumps of D1 and Durable Object databases, full-text search indexes included;
- a Worker in your own account runs it on Cloudflare Workflows, keeps a catalog of runs and
  snapshots, and keeps 7 daily, 4 weekly and 12 monthly snapshots.

Durable Objects, R2 and KV sources, the copy outside Cloudflare, restore tests and a restore command
come next. See [docs/deploy.md](docs/deploy.md), [docs/architecture.md](docs/architecture.md) and
[docs/format.md](docs/format.md).

## License

[AGPL-3.0](LICENSE).
