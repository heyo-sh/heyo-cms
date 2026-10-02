#!/usr/bin/env bun
/**
 * `bun create @heyo-sh/heyo-cms`.
 *
 * Built in stage 10. Thanks to the auto-handler (section 10 of the plan) it is
 * radically simpler than its sibling in heyo-docs: each template mounts the
 * whole CMS from a single catch-all file, so there is no overlay per endpoint
 * to generate.
 *
 * Kept private until the templates exist, so a stub cannot be published.
 */

const templates = ["next", "astro", "react-router"] as const;
const deployments = ["vercel", "cloudflare"] as const;
const databases = ["postgres", "mongodb", "d1"] as const;

export function plannedCombinations(): string[] {
  return templates.flatMap((template) =>
    deployments.map((deployment) => `${template}-${deployment}`),
  );
}

if (import.meta.main) {
  console.log(
    [
      "",
      "  create-heyo-cms is scaffolded in stage 10.",
      "",
      `  Planned templates:   ${templates.join(", ")}`,
      `  Planned deployments: ${deployments.join(", ")}`,
      `  Planned databases:   ${databases.join(", ")}`,
      "",
      "  Until then, copy examples/next/heyo-cms.config.ts into a project and run",
      "  `heyo-cms generate && heyo-cms migrate`.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}
