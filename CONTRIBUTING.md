# Contributing to Heyo CMS

Thanks for helping improve Heyo CMS. Contributions can cover the engine,
database adapters, fields, the admin panel, docs, tests or examples.

## Before opening an issue

Search existing issues and discussions first. Use an issue for a reproducible
bug or a scoped proposal; use GitHub Discussions for questions and early ideas.
Security vulnerabilities must be reported privately as described in
[SECURITY.md](SECURITY.md).

## Local setup

Heyo CMS is a Bun workspace. Use the version declared in `package.json`.

```bash
bun install --frozen-lockfile
bun run lint
bun run knip
bun run typecheck
bun test
bun run build
```

The workspace contains:

- `packages/heyo-cms` — contracts, fields, schema, database adapters, CLI.
- `packages/heyo-cms-admin` — the bundled admin panel.
- `packages/create-heyo-cms` — generator, templates and initial migrations.
- `examples/next` — the comprehensive configuration example.
- `website` — a heyo-docs site for `docs/`; run `bun run docs:dev`.

`bun run example smoke` generates six ignored framework/platform projects
under `examples/`, installs local release tarballs, then checks real framework
dev servers against a database. `bun run example build` separately checks
production bundles. Both also run in CI; they are separate from `quality`.
Generated examples are not workspaces and do not change the root lockfile.
Move them aside before testing template changes so they are regenerated.

After changing template configuration, run `bun run templates` and review the
migration diff. `bun run templates --check` detects drift; generated migration
bytes must not be hand-formatted. Build the docs with `bun run docs:build`.

## What a change to each layer needs

| Change                 | Also needs                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| A new field type       | `defineField()`, a test in `test/fields.test.ts`, a note in the README table |
| A database adapter     | passing `test/contract/database-adapter.ts` unmodified                       |
| A storage adapter      | passing `test/contract/storage-adapter.ts` unmodified                        |
| A migration step kind  | a renderer in every adapter, plus `describeStep()`                           |
| A configuration option | validation in `src/config.ts` with a test that proves the error message      |

The contract suites are deliberately shared. If a change makes an adapter fail
one of them, the fix belongs in the adapter — a special case in the suite
defeats the reason it exists.

## Pull requests

1. Start from an up-to-date `main` branch and keep the pull request focused.
2. Explain the user-facing effect and link the related issue.
3. Add a regression test for fixes and tests for new public behaviour.
4. Update the public documentation and examples when a contract changes.
5. Run all local checks above. CI runs the same checks and must pass.

For a user-facing package change, also run `bun run changeset` and commit the
generated file from `.changeset/`. Do not add a changeset for documentation,
CI, or test-only changes.

Avoid committing generated `dist`, `build`, framework output, dependency
directories, secrets, or local environment files.

## Contribution license

By submitting a contribution, you confirm that you have the right to submit it
and license your contribution under this repository's [MIT License](LICENSE).

## Public API and compatibility

Treat the types in `src/types`, the configuration surface, the migration file
format and the CLI as public contracts. A change to the rendered output of a
migration is a breaking change even when the types stay the same: a file that
was already applied is checked against its recorded checksum, and a repository
that regenerates differently is one that cannot be deployed twice.
