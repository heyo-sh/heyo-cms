import { heyoDocs } from "@heyo-sh/heyo-docs/config";

export default heyoDocs({
  siteUrl: "https://cms.heyo.sh",
  title: "Heyo CMS",
  description:
    "A TypeScript-first headless CMS for Next.js, Astro and React Router.",
  content: "../docs",
  theme: "moss",
  branding: { name: "Heyo CMS" },
  groups: [
    {
      group: "Documentation",
      icon: "book",
      sections: [
        {
          section: "Start here",
          pages: [
            "index",
            "quickstart/next",
            "quickstart/astro",
            "quickstart/react-router",
          ],
        },
        {
          section: "Reference",
          pages: [
            "configuration",
            "fields",
            "hooks",
            "media",
            "rbac",
            "i18n",
            "ai",
            "webhooks",
            "caching",
          ],
        },
        {
          section: "Operations",
          pages: ["cli", "deployment", "migrating-from-payload"],
        },
      ],
    },
  ],
  footer: { github: "https://github.com/heyo-sh/heyo-cms" },
});
