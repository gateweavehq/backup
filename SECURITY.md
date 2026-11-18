# Security policy

## Supported versions

Gateweave Backup is in early development and has no release yet. Security fixes go into `main`,
and into the latest release once there is one.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/backup/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
Never send a backup key, a token or anything a backup holds: a repository made with a key of
your own for the report shows as much. We aim to reply within three working days, and will keep
you updated while we work on a fix, and credit you in the release notes unless you would rather
stay anonymous.

## Scope

Areas where reports are especially valuable:

- The key or plaintext leaving memory: the master key, a derived key or an unsealed chunk reaching
  the bucket, the catalog, a log, an alert, an error's message or the copy outside Cloudflare.
- Sealing: a blob that opens under another name or in another repository, a changed blob that
  opens, or anything the bucket or the copy shows someone without the key beyond what
  [docs/format.md](docs/format.md) says it shows (object names, sizes and times).
- A restore that writes over something: the CLI replacing a file or an object in a bucket, or
  writing outside the folder it was given.
- A restore test that leaves a source's rows behind in its Durable Object.
- Retention deleting what a kept snapshot needs, or a run that deletes while another writes.
- The read an app lends: a statement that gets past the guard in
  [docs/app-entrypoint.md](docs/app-entrypoint.md) and changes an object, or a way to reach an
  app's `Backup` entrypoint without a service binding.
- A source that makes the Worker write to it. Sources are read, never written.
- Alerts: a webhook's signature that can be forged, or an alert that carries data.

The Worker answers no requests, so it has no public surface of its own. A problem that needs the
attacker to hold the master key, or to deploy code to the account the Worker runs in, is outside
what Backup can defend against; say so in the report and we will still read it.
