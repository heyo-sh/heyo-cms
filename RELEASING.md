# Releasing Heyo CMS

Packages are versioned with [Changesets](https://github.com/changesets/changesets)
and published only by GitHub Actions.

| Package                    | Contents                                 | Published    |
| -------------------------- | ---------------------------------------- | ------------ |
| `@heyo-sh/heyo-cms`        | contracts, fields, schema, adapters, CLI | from stage 3 |
| `@heyo-sh/heyo-cms-admin`  | admin panel                              | stage 8      |
| `@heyo-sh/create-heyo-cms` | project generator and templates          | stage 10     |

Only `@heyo-sh/heyo-cms` is publishable today. The other two are `private`
until they do something, which also keeps Changesets from versioning them.

## One-time repository setup

1. In npm, verify that the account creating the token belongs to the `@heyo-sh`
   organization and can publish organization packages. Do not create the
   package in npm's UI: the first approved release creates it.
2. For the first publish only, create an npm automation or granular token with
   publish access to the package (or to the `@heyo-sh` scope).
3. In GitHub, create an environment named `npm`, restrict it to `main`, and add
   the reviewers required for a production release.
4. Add the token as the `NPM_TOKEN` secret in that `npm` environment, not as a
   repository-wide secret. The publish job reads it as `NODE_AUTH_TOKEN`.
5. In npm, enable 2FA for the owning account or organization and grant publish
   access only to the required maintainers.
6. In GitHub Actions settings, allow the workflow `GITHUB_TOKEN` to create pull
   requests and write repository contents.
7. Once the package exists on npm, configure its **Trusted Publisher** for the
   `heyo-sh/heyo-cms` repository, the `release.yml` workflow and the `npm`
   environment, then remove `NPM_TOKEN`. The workflow already requests
   `id-token: write`, so publishing continues over OIDC.

## Normal release flow

1. For every user-facing change, run `bun run changeset`, choose the smallest
   correct semver bump and commit the generated file.
2. Merge the pull request into `main`.
3. The **Release** workflow opens or updates a version pull request.
4. Review and merge it. The workflow then asks for approval of the `npm`
   environment and publishes the versioned packages.

## Before a release

1. `bun run quality` — lint, knip, typecheck, tests, build.
2. `bun run example smoke` — every scaffolded example, against a real database.
3. `bun pm pack --dry-run` in `packages/heyo-cms`, confirming `dist`,
   `README.md` and `LICENSE` are present and that no `.env`, database file or
   source map of a private file is included.

Migrations deserve particular care: a published `plan()` that is not
deterministic produces a different migration on every machine, and a `render()`
whose output changed makes already-applied files fail their checksum. Both are
covered by `test/schema.test.ts` and `test/migrations.test.ts` — if either
starts failing after a refactor, that is the test doing its job.

Never publish from a local machine.
