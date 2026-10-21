import { richTextFromMarkdown, systemActor } from "@heyo-sh/heyo-cms";

import { cms } from "./heyo-cms.config.ts";

/**
 * `heyo-cms seed` runs this.
 *
 * It writes through the ordinary API, so the same access control, hooks and
 * events apply as to a save in the panel — a seed that reached past them
 * would be a second way into the database and would stop proving anything.
 *
 * Idempotent on purpose: a seed that duplicates itself every time somebody
 * runs it is its own bug report.
 */
export async function seed(instance = cms): Promise<void> {
  const actor = systemActor("seed");

  const existing = await instance.api.posts.find({ actor, limit: 1 });
  if (existing.docs.length > 0) {
    console.log("Already seeded.");
    return;
  }

  await instance.globals.settings.update({
    data: { siteName: "{{PROJECT_NAME}}", tagline: "Built with Heyo CMS." },
    actor,
    source: "cli",
  });

  await instance.api.pages.create({
    data: {
      title: "About",
      // Rich text is a document, not a string: TipTap writes it in the panel
      // and the serialisers read it back out as HTML, Markdown or text.
      body: richTextFromMarkdown("This page is editable in the panel."),
    },
    actor,
    source: "cli",
  });

  await instance.api.posts.create({
    data: {
      title: "Hello from Heyo CMS",
      status: "published",
      excerpt: "Delete this once you have written your own.",
      body: richTextFromMarkdown(
        [
          "Open the panel and edit this post.",
          "",
          "The API answers with the new version immediately — there is no build step between the two.",
        ].join("\n"),
      ),
    },
    actor,
    source: "cli",
  });

  console.log("Seeded one page and one post.");
}
