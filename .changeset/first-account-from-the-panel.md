---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
"@heyo-sh/create-heyo-cms": minor
---

The first administrator can be created from the sign-in screen.

A CMS whose `cms_users` table is empty has nobody to sign in as, so the panel
now offers to create that account instead of asking for a password that does
not exist — `heyo-cms create-admin` is no longer the only way in, and the
generated projects no longer print it as a required step.

The offer closes behind the account it creates: `POST /auth/setup` is
registered only while there are no accounts, and the count is taken inside the
transaction that does the insert, so two browsers racing produce one
administrator and one 409. `GET /panel` reports it as `auth.setupRequired`,
`cms.auth.setup` is the same thing without HTTP, and
`admin.auth.firstUser: false` turns it off for deployments that provision
editors from a pipeline. `firstUser: { roles: [...] }` names the roles the
first account is given; the default is `admin`.
