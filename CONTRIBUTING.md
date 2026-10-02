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
- `packages/heyo-cms-admin` — the admin panel (stage 8).
- `packages/create-heyo-cms` — project generator and templates (stage 10).
- `examples/*` — runnable examples, driven by `bun run example`.

`bun run example smoke` boots the examples against a real database. It is the
canonical way to check a change in the schema layer, the adapters or the
handler, and it enters `quality` with the HTTP handler in stage 7.

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
