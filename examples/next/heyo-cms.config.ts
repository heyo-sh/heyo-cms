import {
  defineCollection,
  defineGlobal,
  heyoCms,
  permits,
} from "@heyo-sh/heyo-cms";
import { adminAssets } from "@heyo-sh/heyo-cms-admin";
import { cmsUsers, oidc } from "@heyo-sh/heyo-cms/auth";
import {
  boolean,
  media,
  relation,
  richText,
  select,
  text,
  textarea,
} from "@heyo-sh/heyo-cms/fields";
import { postgres } from "@heyo-sh/heyo-cms/postgres";
import { local, s3, sharpImages } from "@heyo-sh/heyo-cms/uploads";

import { reviews } from "./plugin";

/**
 * The target developer experience, written out in full.
 *
 * This file is section 3 of the plan, compiled. It is type-checked in CI, so
 * a contract that drifts away from the experience it promised fails the build
 * rather than the documentation review. Nothing here is aspirational syntax:
 * every call below exists today.
 *
 * `api-route.ts` next to it is the other half: the one file that mounts all of
 * it over HTTP. `bun run example up next` serves exactly this configuration,
 * seeded, on http://localhost:4320.
 */

/**
 * Local defaults, so the example is runnable before any secret exists.
 * `bun run example smoke next` migrates a real Postgres with exactly this.
 */
const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://localhost:5432/heyo_cms_next",
  OIDC_ISSUER: process.env.OIDC_ISSUER ?? "https://accounts.google.com",
  BUCKET: process.env.BUCKET ?? "heyo-cms-example",
  REGION: process.env.REGION ?? "eu-central-1",
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "local-client-id",
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "local-client-secret", // prettier-ignore
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-local",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-local",
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? "sk-local",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? "local-webhook-secret",
  AI_KEY_SECRET: process.env.AI_KEY_SECRET ?? "local-ai-key-secret-01",
};

/**
 * A directory instead of a bucket, when one is given.
 *
 * `StorageAdapter` is the same five methods either way, so development and
 * `bun run example smoke` exercise the identical upload pipeline, variant
 * rendering and collection that production does — without an AWS account.
 */
const mediaDirectory = process.env.MEDIA_DIR;

export const cms = heyoCms({
  database: postgres(env.DATABASE_URL),

  // ---- EDITOR AUTHENTICATION -------------------------------------------
  admin: {
    path: "/admin",
    title: "Acme",
    // The panel, served from this same handler under `/admin`. One bundle,
    // no second deployment, no CORS: it learns the collections, the fields
    // and the languages from `GET /panel` at runtime.
    assets: adminAssets(),
    auth: cmsUsers({
      methods: ["password", "magic-link", "github", "google"],
      // Optional, and resolved at sign-in rather than at build time: this
      // file has to load on a laptop where the OAuth app does not exist yet,
      // and `GITHUB_CLIENT_ID` works just as well as writing it here.
      providers: {
        github: {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        },
      },
      sso: oidc({
        issuer: env.OIDC_ISSUER,
        mapRoles: (claims) => (claims.groups as string[]) ?? [],
      }),
      twoFactor: true,
      apiKeys: { enabled: true, scopes: ["read", "write"] },
      session: { expiresIn: "7d" },
    }),
  },

  // ---- RBAC ------------------------------------------------------------
  rbac: {
    roles: {
      admin: ["*"],
      // `reviews:*` is the plugin's collection: installing a plugin means
      // granting the permissions its collection needs, exactly as for one
      // the application declared itself.
      editor: ["posts:*", "reviews:*", "media:*", "pages:read", "pages:update"], // prettier-ignore
      // No `posts:publish`, so a writer drafts and somebody else publishes.
      writer: ["posts:read", "posts:create", "posts:update"],
      viewer: ["*:read"],
    },
    customRoles: true,
  },

  // ---- I18N ------------------------------------------------------------
  // Codes, and nothing else: "English" and "French" follow from them, and so
  // does which of the two is written right to left. A field with no French
  // value is answered in English and says so through `_fallback`.
  i18n: {
    defaultLocale: "en",
    locales: ["en", "fr"],
  },

  // ---- MEDIA -----------------------------------------------------------
  uploads: {
    storage: mediaDirectory
      ? local({ directory: mediaDirectory, baseUrl: "/media" })
      : s3({ bucket: env.BUCKET, region: env.REGION }),

    limits: {
      maxFileSize: "25mb",
      maxImageDimensions: { width: 8000, height: 8000 },
      accept: ["image/*", "video/mp4", "application/pdf"],
    },

    images: {
      // What renders pixels. Needed here because `convert` and
      // `maxDimensions` promise bytes that do not exist yet; a deployment
      // that resizes at the edge drops this and keeps `on-demand` variants,
      // whose URLs then carry the size for the CDN.
      processor: sharpImages(),
      convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
      quality: 82,
      // Performed by the engine itself, with or without a processor: a phone
      // photograph carries the coordinates of where it was taken.
      stripMetadata: true,
      maxDimensions: { width: 3840, height: 3840 },
      focalPoint: true,
      crop: true,
      variants: {
        mode: "on-demand",
        sizes: {
          thumb: { width: 320, height: 320, fit: "cover" },
          card: { width: 768 },
          hero: { width: 1920 },
        },
      },
    },

    // Losing the last reference marks a file unused; it keeps serving for
    // thirty days, and using it again reclaims it. `media-gc` is the only
    // thing in the product that deletes a file.
    retention: {
      orphanAfterUnreferenced: true,
      purgeAfter: "30d",
      reclaimOnReference: true,
    },
  },

  // ---- AI --------------------------------------------------------------
  // Credentials, the default model and the panel-wide assistant. There is no
  // task list: what AI can do on a *field* lives on the field that can do it,
  // and what the assistant can reach is decided at runtime from this
  // configuration and the signed-in actor.
  ai: {
    auth: {
      openai: { type: "api-key", token: env.OPENAI_API_KEY },
      anthropic: { type: "api-key", token: env.ANTHROPIC_API_KEY },
      google: { type: "api-key", token: env.GOOGLE_API_KEY },
    },
    defaultModel: { provider: "openai", model: "gpt-4o-mini" },
    assistant: {
      enabled: true,
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      instructions: "You edit a technical blog. Be concrete.",
      // Budgets the server enforces. The prompt is not where limits live:
      // a limit a model can talk itself out of is not a limit.
      maxTurns: 8,
      maxToolCalls: 16,
    },
    // Lets an administrator type a provider key into the settings screen.
    // It is encrypted with this secret before it is stored and is never
    // answered with — the panel only ever sees the last four characters.
    // A key stored this way wins over the ones above.
    storage: { secret: env.AI_KEY_SECRET },
  },

  // ---- WEBHOOKS --------------------------------------------------------
  webhooks: {
    enabled: true,
    signing: { algorithm: "hmac-sha256", secret: env.WEBHOOK_SECRET },
    delivery: {
      retries: 5,
      backoff: "exponential",
      timeout: "10s",
      dlq: true,
    },
    managedInAdmin: true,
  },

  // ---- TRASH -----------------------------------------------------------
  // A delete sets `deleted_at` and a deadline; `cms.jobs.run()` removes what
  // is past it. `purgeAfter: false` would keep deleted documents forever.
  trash: { enabled: true, purgeAfter: "30d" },

  // ---- GLOBALS ---------------------------------------------------------
  // Singletons: one row, no `find`, no `create`, same hooks and events.
  globals: {
    settings: defineGlobal({
      label: "Site settings",
      fields: {
        siteName: text({ required: true, default: "Acme" }),
        tagline: textarea({ localized: true }),
        maintenance: boolean({
          default: false,
          // Who may take the site down is who may write this field, exactly
          // as with `status` on a post.
          access: { update: ({ actor }) => permits(actor, "settings:update") },
        }),
      },
    }),
  },

  // ---- COLLECTIONS -----------------------------------------------------
  collections: {
    posts: defineCollection({
      fields: {
        // An ordinary select. The engine attaches no meaning to it — and this
        // is the whole of "who may publish": whoever may write this field.
        status: select({
          options: ["draft", "review", "published"],
          default: "draft",
          access: { update: ({ actor }) => permits(actor, "posts:publish") },
        }),

        title: text({
          localized: true,
          required: true,
          aiGenerate: {
            label: "Suggest a title",
            prompt: "Write a short, concrete title for this article.",
            context: ["body"],
          },
          ai: { translate: true },
        }),

        handle: text({
          unique: true,
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          generate: ({ fields }) =>
            String(fields.title ?? "")
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
          aiGenerate: {
            label: "Suggest handle",
            prompt:
              "Suggest a lowercase, hyphenated URL handle from the title.",
            context: ["title"],
          },
        }),

        body: richText({
          localized: true,
          aiGenerate: {
            prompt: "Write the article from the title and the notes.",
            context: ["title", "excerpt"],
            model: { provider: "anthropic", model: "claude-sonnet-4-5" },
          },
          ai: { translate: true },
        }),

        excerpt: text({
          localized: true,
          ai: {
            summarize: { prompt: "Two sentences.", context: ["body"] },
          },
        }),

        cover: media({
          accept: "image/*",
          ai: { alt: true },
        }),

        author: relation("cms_users"),
      },

      // v1: CRUD only. Who may publish is who may write `status`, above.
      access: {
        read: () => true,
        create: ({ actor }) => permits(actor, "posts:create"),
        update: ({ actor, record }) =>
          permits(actor, "posts:update") ||
          (actor !== null && record?.authorId === actor.id),
        delete: ({ actor }) => actor?.roles.includes("admin") ?? false,
      },
    }),
  },

  // ---- PLUGINS ---------------------------------------------------------
  // `./plugin.ts` is a third-party plugin written against the published
  // entry points: a collection, a field type, an editor node, an AI action,
  // a route, a migration and a patch to `posts`. Installing it is this line.
  plugins: [reviews],
});
