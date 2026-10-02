import { defineCollection, heyoCms } from "@heyo-sh/heyo-cms";
import { cmsUsers, oidc } from "@heyo-sh/heyo-cms/auth";
import {
  media,
  relation,
  richText,
  select,
  text,
} from "@heyo-sh/heyo-cms/fields";
import { postgres } from "@heyo-sh/heyo-cms/postgres";
import { s3 } from "@heyo-sh/heyo-cms/uploads";

/**
 * The target developer experience, written out in full.
 *
 * This file is section 3 of the plan, compiled. It is type-checked in CI, so
 * a contract that drifts away from the experience it promised fails the build
 * rather than the documentation review. Nothing here is aspirational syntax:
 * every call below exists today.
 *
 * What is not wired up yet is marked inline — the media transport lands with
 * stage 6 and the HTTP handler with stage 7.
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
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-local",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-local",
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? "sk-local",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? "local-webhook-secret",
};

export const cms = heyoCms({
  database: postgres(env.DATABASE_URL),

  // ---- EDITOR AUTHENTICATION -------------------------------------------
  admin: {
    path: "/admin",
    auth: cmsUsers({
      methods: ["password", "magic-link", "github", "google"],
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
      editor: ["posts:*", "media:*", "pages:read", "pages:update"],
      writer: ["posts:read", "posts:create", "posts:update"],
      viewer: ["*:read"],
    },
    customRoles: true,
  },

  // ---- I18N ------------------------------------------------------------
  i18n: {
    locales: "dynamic",
    defaultLocale: "en",
    fallback: { mode: "default-locale", markAsFallback: true },
  },

  // ---- MEDIA -----------------------------------------------------------
  uploads: {
    // The S3 transport arrives with the media pipeline in stage 6; the
    // options are validated today.
    storage: s3({ bucket: env.BUCKET, region: env.REGION }),

    limits: {
      maxFileSize: "25mb",
      maxImageDimensions: { width: 8000, height: 8000 },
      accept: ["image/*", "video/mp4", "application/pdf"],
    },

    images: {
      convert: { to: "webp", keep: ["image/gif", "image/svg+xml"] },
      quality: 82,
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

    retention: {
      orphanAfterUnreferenced: true,
      purgeAfter: "30d",
      reclaimOnReference: true,
    },
  },

  // ---- AI --------------------------------------------------------------
  // Credentials, the default model and chat. No task list: what AI can do
  // lives on the field that can do it.
  ai: {
    auth: {
      openai: { type: "api-key", token: env.OPENAI_API_KEY },
      anthropic: { type: "api-key", token: env.ANTHROPIC_API_KEY },
      google: { type: "api-key", token: env.GOOGLE_API_KEY },
    },
    defaultModel: { provider: "openai", model: "gpt-4o-mini" },
    chat: {
      enabled: true,
      model: { provider: "anthropic", model: "claude-sonnet-4" },
    },
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
  trash: { enabled: true, purgeAfter: "30d" },

  // ---- COLLECTIONS -----------------------------------------------------
  collections: {
    posts: defineCollection({
      fields: {
        // An ordinary select. The engine attaches no meaning to it.
        status: select({
          options: ["draft", "review", "published"],
          default: "draft",
        }),

        title: text({
          localized: true,
          required: true,
          // One key, one button in the AI menu next to this field.
          ai: {
            generate: {
              label: "Suggest a title",
              prompt: "Write a short, concrete title for this article.",
              context: ["body"],
            },
            improve: {
              label: "Improve",
              prompt: "Keep the meaning, cut the length, drop the clickbait.",
            },
            translate: true,
          },
        }),

        body: richText({
          localized: true,
          ai: {
            generate: {
              prompt: "Write the article from the title and the notes.",
              context: ["title", "excerpt"],
              model: { provider: "anthropic", model: "claude-sonnet-4" },
            },
            improve: true,
            translate: true,
          },
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

      // Chat over the whole document. `context` is required.
      ai: {
        chat: {
          context: ["title", "body", "excerpt"],
          instructions: "You edit a technical blog. Be concrete.",
        },
      },

      // v1: CRUD only. Who may publish is who may write `status`.
      access: {
        read: () => true,
        create: ({ actor }) => actor?.permissions.includes("posts:create") ?? false, // prettier-ignore
        update: ({ actor, record }) =>
          (actor?.permissions.includes("posts:update") ?? false) ||
          record?.authorId === actor?.id,
        delete: ({ actor }) => actor?.roles.includes("admin") ?? false,
      },
    }),
  },

  plugins: [],
});
