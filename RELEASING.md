# Releasing Heyo CMS

Packages are versioned with [Changesets](https://github.com/changesets/changesets)
and published only by GitHub Actions.

| Package                    | Contents                                 | Published       |
| -------------------------- | ---------------------------------------- | --------------- |
| `@heyo-sh/heyo-cms`        | engine, adapters, CLI                    | 0.1.0 candidate |
| `@heyo-sh/heyo-cms-admin`  | bundled panel                            | 0.1.0 candidate |
| `@heyo-sh/create-heyo-cms` | generator, templates, initial migrations | 0.1.0 candidate |

All three packages are MIT and publishable. Changesets has prepared the 0.1.0
versions and changelogs; this does not mean they have been published. The
private `website` package is the heyo-docs site and is never published to npm.

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
2. `bun run docs:build` and `bun run templates --check`.
3. Move existing generated `examples/{next,astro,react-router}-{vercel,cloudflare}`
   aside before validation, so the harness regenerates the current templates.
   `bun run example smoke` tests each against a real database and dev server;
   `bun run example build` checks production bundles (including OpenNext).
   Generated examples install local release tarballs independently; their
   dependency locks do not enter the root workspace lockfile.
4. In the three generated Cloudflare projects, `bunx wrangler deploy --dry-run`
   checks Worker packaging without publishing. Live deployments, remote D1,
   MongoDB and credentialed S3/R2 still require account-specific verification.
5. `npm pack --dry-run --json` in **each** publishable package. Verify `dist`,
   `README.md`, `LICENSE`, all generator layers, SQL/JSON migrations and
   `meta/snapshot.json`. No credentials, local database or private source maps.
6. Install the resulting tarballs outside the workspace, check the Node CLI
   and generator `--help`, and scaffold with `--no-install`. Public peer
   dependencies must use semver ranges, not `workspace:*` (npm does not rewrite
   that protocol when packing). Dev-only workspace dependencies stay local.
7. Run `bun install --frozen-lockfile` on a clean checkout. Approve publication
   only after all checks and credentials/trusted-publisher setup are complete.

Migrations deserve particular care: a published `plan()` that is not
deterministic produces a different migration on every machine, and a `render()`
whose output changed makes already-applied files fail their checksum. Both are
covered by `test/schema.test.ts` and `test/migrations.test.ts` — if either
starts failing after a refactor, that is the test doing its job.

Never publish from a local machine.
