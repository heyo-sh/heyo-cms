import { defineCollection, defineGlobal, heyoCms, permits } from "@heyo-sh/heyo-cms"; // prettier-ignore
import { adminAssets } from "@heyo-sh/heyo-cms-admin";
import { cmsUsers } from "@heyo-sh/heyo-cms/auth";
import { media, richText, select, text, textarea } from "@heyo-sh/heyo-cms/fields"; // prettier-ignore
{{CONFIG_IMPORTS}}

import { postTags, revalidatePosts } from "./heyo-cms.cache.ts";

/**
 * The CMS. One file, and the only one that describes it.
 *
 * Everything here is ordinary TypeScript: change a field, run
 * `heyo-cms generate` and a migration appears in `migrations/` for you to
 * read before it runs. There is no `push` mode and no hidden schema state.
 *
 * The file is in two halves. First the deployment — the database, the bucket
 * and whether this runtime can resize an image — which is the part that
 * differs between a laptop, Vercel and a Worker. Then the CMS itself, which
 * does not differ at all: the same collections run against Postgres on Vercel
 * and against D1 on Cloudflare without a line changing.
 */

// ---------------------------------------------------------------------------
// The deployment
// ---------------------------------------------------------------------------

{{DATABASE_CONFIG}}

{{STORAGE_CONFIG}}

{{IMAGES_CONFIG}}

// ---------------------------------------------------------------------------
// The CMS
// ---------------------------------------------------------------------------

export const cms = heyoCms({
  database,

  // Editor authentication and the panel, served from the same route as the
  // API: there is no second deployment and no CORS to configure.
  admin: {
    path: "/admin",
    title: "{{PROJECT_NAME}}",
    assets: adminAssets(),
    auth: cmsUsers({
      methods: ["password"],
      session: { expiresIn: "7d" },
      // Machine credentials for a build, a script or a preview deployment.
      // A key is narrowed to its scopes and may never issue another key.
      apiKeys: { enabled: true, scopes: ["read", "write"] },
    }),
  },

  // Roles are permissions, and permissions are `collection:action`. Declaring
  // this section switches every collection without an `access` rule from
  // "open" to "needs the permission", which is the only safe reading once
  // roles exist at all.
  rbac: {
    roles: {
      admin: ["*"],
      editor: ["posts:*", "pages:*", "media:*", "settings:*"],
      // No `posts:publish`, so a writer drafts and an editor publishes. That
      // is the whole publishing workflow: `status` is a field, and who may
      // write it is who may publish.
      writer: ["posts:read", "posts:create", "posts:update", "media:create"],
      viewer: ["*:read"],
    },
    customRoles: true,
  },

  // Codes, and nothing else: the name of each language and whether it is
  // written right to left follow from the code. A field with no value in the
  // language being read falls back to `defaultLocale` and says that it did,
  // which is what the panel's "untranslated" badge reads.
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  uploads: {
    storage,
    images,
    limits: {
      maxFileSize: "25mb",
      maxImageDimensions: { width: 8000, height: 8000 },
      accept: ["image/*", "video/mp4", "application/pdf"],
    },
    // Losing the last reference to a file marks it unused; it keeps serving
    // for thirty days, and using it again reclaims it. Nothing else in the
    // product deletes a file.
    retention: {
      orphanAfterUnreferenced: true,
      purgeAfter: "30d",
      reclaimOnReference: true,
    },
  },

  // A delete sets a deadline instead of removing a row. `heyo-cms` sweeps
  // what is past it when `cms.jobs.run()` is called — see the cron route.
  trash: { enabled: true, purgeAfter: "30d" },

  globals: {
    settings: defineGlobal({
      label: "Site settings",
      // The site renders these, so reading them is public; writing them is
      // not. Without an `access` rule a global needs `settings:read`, which
      // an anonymous visitor does not have.
      access: {
        read: () => true,
        update: ({ actor }) => permits(actor, "settings:update"),
      },
      fields: {
        siteName: text({ required: true, default: "{{PROJECT_NAME}}" }),
        tagline: textarea({ localized: true }),
      },
    }),
  },

  collections: {
    posts: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        // A URL handle is a text field with a pattern on it, not a type of
        // its own. Generating it from the title is a `create.before` hook,
        // which runs before validation for exactly this reason.
        handle: text({
          unique: true,
          index: true,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        }),
        // An ordinary select. The engine attaches no meaning to it: this is
        // the publishing state, and the `access` rule below is who may change
        // it.
        status: select({
          options: ["draft", "review", "published"],
          default: "draft",
          access: { update: ({ actor }) => permits(actor, "posts:publish") },
        }),
        excerpt: textarea({ localized: true }),
        cover: media({ accept: "image/*" }),
        body: richText({ localized: true }),
      },
      access: {
        // The site is public; everything else needs the permission.
        read: () => true,
        create: ({ actor }) => permits(actor, "posts:create"),
        update: ({ actor }) => permits(actor, "posts:update"),
        delete: ({ actor }) => permits(actor, "posts:delete"),
      },
    }),

    pages: defineCollection({
      fields: {
        title: text({ required: true, localized: true }),
        handle: text({
          unique: true,
          index: true,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        }),
        body: richText({ localized: true }),
      },
      access: { read: () => true },
    }),
  },

  // -------------------------------------------------------------------------
  // The cache
  // -------------------------------------------------------------------------

  /**
   * A write empties the views that read it.
   *
   * This is the whole of the cache integration. The views tag what they read
   * (`heyo-cms.cache.ts` holds the names), and these three hooks purge the
   * same tags the moment a post changes — including a change made by the
   * panel, by `cms.api`, by an API key or by a scheduled publication running
   * under the cron, because all four go through the one write path.
   *
   * An `after` hook runs inside the write transaction, which is the
   * deliberate choice rather than the convenient one: the alternative is an
   * event listener, which fires after the response has been sent, and on
   * serverless the process is frozen by then and the purge never happens.
   * The cost is a purge that is occasionally a moment early.
   *
   * Both sides of an update are purged, because renaming a post from
   * `/posts/old` to `/posts/new` has to empty both and only `previous` knows
   * the first one.
   */
  databaseHooks: {
    posts: {
      create: { after: (doc) => revalidatePosts(postTags(doc)) },
      update: {
        after: ({ doc, previous }) =>
          revalidatePosts([...postTags(doc), ...postTags(previous)]),
      },
      delete: { after: (doc) => revalidatePosts(postTags(doc)) },
    },
  },
});
