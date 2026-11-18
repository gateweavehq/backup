## What and why

<!-- What does this change, and why is it needed? Link the issue it closes: "Closes #123". -->

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

- [ ] `pnpm verify` passes
- [ ] Tests cover the change (every bug fix has a test that fails without it)

## Deploy notes

<!-- Delete what does not apply. -->

- [ ] Adds a migration of the catalog (`apps/worker/migrations`, applied with `wrangler d1 migrations apply` before the new code is deployed)
- [ ] Adds a setting or secret (in `apps/worker/wrangler.jsonc` and `docs/deploy.md`)
- [ ] Changes what a repository holds (a new format version in `docs/format.md`, never an edit to version 1, and the test that reads old repositories still passes)
- [ ] Changes what an app's `Backup` entrypoint is asked (`docs/app-entrypoint.md` and its example)
