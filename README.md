# Gateweave Backup

Scheduled, encrypted backups of what your app keeps on Cloudflare: D1 databases, Durable Objects'
SQLite, R2 buckets and KV. A copy goes outside Cloudflare, and every month a restore proves the
backups work.

It is early. Today the repository holds the format and its core:

- data is sealed with AES-256-GCM before it leaves, under a key only you hold;
- content-defined chunking, so a nightly backup stores only what changed;
- exact SQLite dumps of D1 and Durable Object databases, full-text search indexes included.

The Worker that runs backups on a schedule comes next. See
[docs/architecture.md](docs/architecture.md) and [docs/format.md](docs/format.md).

## License

[AGPL-3.0](LICENSE).
