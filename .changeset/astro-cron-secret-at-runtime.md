---
"@heyo-sh/create-heyo-cms": patch
---

**The Astro template no longer writes `CRON_SECRET` into the server bundle.**
`src/pages/api/cron.ts` read the secret as
`import.meta.env.CRON_SECRET ?? process.env.CRON_SECRET`. Astro replaces
`import.meta.env.NAME` with the value it finds at build time — in `.env` or
the shell — for every variable without a `PUBLIC_` prefix, so a project built
with `CRON_SECRET` set had the literal value in the cron chunk
(`dist/server` on Cloudflare, `.vercel/output/functions` on Vercel), and the
route kept checking that value: a secret changed later with
`wrangler secret put` or in Vercel's settings was refused, and a build made
from a copied `.env.example` accepted `Bearer change-me`. Projects with no
`CRON_SECRET` at build time were not affected.

The route now reads it with `getSecret("CRON_SECRET")` from
`astro:env/server`, which looks it up when a request arrives: from the Worker's
bindings on Cloudflare, from `process.env` on Vercel, and from `.env` in
`astro dev`. Existing Astro projects should make the same one-line change and
redeploy.

**`astro dev` now sees `.env`.** Astro hands `.env` to `import.meta.env` only,
while `heyo-cms.config.ts` reads `DATABASE_URL`, `MONGODB_URL` and the
storage keys from `process.env`, so following the README
(`cp .env.example .env`, then `dev`) failed with "DATABASE_URL is not set" on
the Vercel deployment. `astro.config.ts` now loads `.env` and `.env.local`
into `process.env` with `process.loadEnvFile`, in the order the `heyo-cms`
CLI uses, without overriding what the shell set.

A scaffold test now fails if any generated project reads a variable through
`import.meta.env` other than the build's own flags, and `bun run example
smoke` checks `/api/cron` in every framework example, with the secret
provided in `.env` as a reader would.
