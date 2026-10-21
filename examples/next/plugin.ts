import { defineAiAction, defineField } from "@heyo-sh/heyo-cms";
import { defineCollection } from "@heyo-sh/heyo-cms";
import { defineEditorNode } from "@heyo-sh/heyo-cms/editor";
import { richText, text } from "@heyo-sh/heyo-cms/fields";
import type { CmsPlugin, FieldOptions } from "@heyo-sh/heyo-cms/types";
import { z } from "zod";

/**
 * A plugin, written the way a third party would write one.
 *
 * It is here, type-checked in CI, because stage 9 is finished when "an
 * external plugin adding a collection, a field, an editor node, a route and
 * a migration works without changes to the core" — and the only honest way
 * to keep that true is to have one in the repository that would break the
 * build if it stopped being true.
 *
 * Everything below uses published entry points. There is no privileged path:
 * the built-in `text()` is declared with the same `defineField()`, the
 * built-in `paragraph` with the same `defineEditorNode()`, and `translate`
 * with the same `defineAiAction()`.
 */

// --- A field type ----------------------------------------------------------

interface StarsOptions extends FieldOptions {
  max?: number;
}

/**
 * `stars({ max: 5 })`.
 *
 * Four things make a field type: a zod schema for one locale's value, a
 * portable column definition, an options schema checked at configuration
 * time, and the AI actions it is allowed to expose. The panel renders it
 * with the control for its column type until the plugin ships one of its
 * own (see `admin.scripts` below).
 */
export const stars = defineField<number, StarsOptions>({
  name: "stars",
  optionsSchema: z.looseObject({
    max: z.number().int().positive().max(10).optional(),
  }) as unknown as z.ZodType<StarsOptions>,
  schema: (options) =>
    z
      .number()
      .int()
      .min(1)
      .max(options.max ?? 5),
  column: () => ({ type: "integer", index: true }),
  aiActions: ["guess-stars"],
});

// --- An editor node --------------------------------------------------------

/**
 * A pull quote.
 *
 * The serialisers are not optional, and that is the point of the contract:
 * a node that only the panel understands turns `GET /posts/1` into a shape
 * no consumer can render. With these two functions the node works in the
 * REST response (`?richText=html`), in a Markdown export and in an AI
 * prompt, on the day it is installed.
 */
export const pullQuote = defineEditorNode({
  name: "pullQuote",
  group: "block",
  content: "inline*",
  attrs: { attribution: { default: null } },
  toHtml: ({ node, children }) => {
    const attribution = node.attrs?.attribution;
    return [
      '<figure class="pull-quote">',
      `<blockquote>${children}</blockquote>`,
      attribution ? `<figcaption>${String(attribution)}</figcaption>` : "",
      "</figure>",
    ].join("");
  },
  toMarkdown: ({ node, children }) => {
    const attribution = node.attrs?.attribution;
    return attribution
      ? `> ${children}\n> — ${String(attribution)}`
      : `> ${children}`;
  },
});

// --- An AI action ----------------------------------------------------------

/**
 * `ai: { "guess-stars": true }` on a `stars` field.
 *
 * An action receives the field, the context the configuration named and a
 * `complete` already bound to the resolved model and credentials — it never
 * sees a token and cannot choose a different provider.
 */
export const guessStars = defineAiAction({
  id: "guess-stars",
  appliesTo: ["stars"],
  label: "Guess a score",
  prompt: "Score this review from 1 to 5 based on its text.",
  run: async (context) => {
    const result = await context.complete({
      system: "Answer with one digit and nothing else.",
      // The field's own prompt when it brings one, the action's otherwise —
      // never a bare "score it", which leaves the 1-5 scale unsaid.
      prompt: `${context.options.prompt ?? guessStars.prompt}\n\n${JSON.stringify(context.context)}`, // prettier-ignore
    });
    const value = Number(result.text.trim());
    return {
      value: Number.isFinite(value) ? value : null,
      preview: result.text.trim(),
      usage: result.usage,
    };
  },
});

// --- The plugin itself -----------------------------------------------------

/** What this plugin adds to the typed client: `client.reviews.top()`. */
export interface ReviewsClient {
  reviews: { top(): Promise<{ count: number }> };
}

export const reviews: CmsPlugin<ReviewsClient> = {
  id: "reviews",

  // A collection of its own, with its own field type. It gets routes, an
  // entry in `cms.api`, a place in the schema and a migration, exactly like
  // a collection the application declared.
  schema: {
    collections: {
      reviews: defineCollection({
        label: "Reviews",
        fields: {
          summary: text({ required: true }),
          body: richText({}),
          score: stars({
            max: 5,
            // Name what the model reads: an action with no context fields is
            // shown an empty document and scores nothing.
            ai: { "guess-stars": { context: ["summary", "body"] } },
          }),
        },
      }),
    },
  },

  // Neutral steps rather than SQL, because the same plugin has to install on
  // Postgres, SQLite and MongoDB. `heyo-cms generate` turns them into a file
  // in the repository, reviewed in the pull request that installed it.
  migrations: [
    {
      id: "index_scores",
      steps: [
        {
          kind: "create_index",
          index: {
            name: "idx_documents_review_score",
            table: "documents",
            // A path into the document body, because every collection
            // shares one table; the predicate keeps the index to this
            // plugin's rows.
            targets: [
              {
                kind: "json",
                column: "data",
                path: ["score"],
                type: "integer",
              },
            ],
            unique: false,
            where: { column: "collection", equals: "reviews" },
          },
        },
      ],
    },
  ],

  // A field and a hook on a collection the application owns. The hook runs
  // before the configuration's own, so the application always has the last
  // word (section 5).
  extendCollections: () => [
    {
      collection: "posts",
      fields: { editorsPick: stars({ max: 3 }) },
    },
  ],

  routes: [
    {
      method: "GET",
      path: "/reviews/top",
      handler: async (context) => {
        const page = await context.cms.api.reviews?.find({
          actor: context.actor,
          limit: 5,
          orderBy: [{ path: "score", direction: "desc" }],
        });
        return context.json({ count: page?.docs.length ?? 0 });
      },
      openapi: {
        summary: "The highest-scoring reviews",
        tags: ["reviews"],
      },
    },
  ],

  client: (base) => ({
    reviews: {
      top: () => base.request("/reviews/top") as Promise<{ count: number }>,
    },
  }),

  admin: {
    navItems: [{ label: "Reviews", path: "/c/reviews" }],
    // The panel loads this before its first render and the script registers
    // a control through `window.heyoCmsPanel.registerField("stars", …)`.
    // Until it does, a `stars` field renders as the number input its column
    // type implies — which is usable rather than broken.
    scripts: [],
  },
};
