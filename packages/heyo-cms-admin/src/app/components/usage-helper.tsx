import { Button, CodeBlock, Sheet, Tabs } from "@heyo-sh/heyo-ui";
import { IconCode, IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";

import { usePanel } from "../lib/panel";

/** Only screens with a useful integration example opt in. Names are the
 * configured API names; slugs are the HTTP routes (they need not match). */
export type Usage =
  | { kind: "dashboard" }
  | { kind: "global"; name: string; slug: string; label: string }
  | { kind: "collection"; name: string; slug: string; label: string }
  | { kind: "document"; name: string; slug: string; id: string; label: string }
  | { kind: "new"; name: string; slug: string; label: string }
  | { kind: "media"; status: "active" | "orphaned" }
  | { kind: "trash" }
  | { kind: "users" }
  | { kind: "locales" }
  | { kind: "keys" };

export interface UsageExample {
  title: string;
  description: string;
  server: string;
  client: string;
}

/** Keep the displayed snippets aligned with the local API and the typed HTTP
 * client. JSON.stringify prevents route data (including document IDs) from
 * becoming executable code in the examples. */
export function usageExample(usage: Usage, locale: string): UsageExample {
  const language = JSON.stringify(locale);
  switch (usage.kind) {
    case "dashboard":
      return {
        title: "Collections",
        description:
          "Discover the configured collections, then read the ones your app needs.",
        server: `// In server code, cms is your configured instance.\nconst collections = Object.keys(cms.collections);\n// For a configured collection (e.g. posts):\nconst page = await cms.api.posts.find({ limit: 10 });`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\nconst panel = await client.request("/panel"); // includes collections\n// Use a collection declared in your CMS configuration:\nconst page = await client.posts.find({ limit: 10 });`,
      };
    case "global": {
      const path = `/globals/${usage.slug}`;
      return {
        title: usage.label,
        description:
          "Read this singleton; an unsaved global returns its configured defaults.",
        server: `const settings = await cms.globals[${JSON.stringify(usage.name)}].get({ locale: ${language} });`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\n${usage.name === usage.slug ? `const settings = await client.globals[${JSON.stringify(usage.name)}].get({ locale: ${language} });` : `// Custom slugs use the HTTP path, not the local API name.\nconst settings = await client.request(${JSON.stringify(path)}, { query: { locale: ${language} } });`}`,
      };
    }
    case "collection":
    case "document":
    case "new": {
      const name = JSON.stringify(usage.name);
      const path = `/${usage.slug}`;
      const list = usage.kind === "collection";
      const create = usage.kind === "new";
      const id = usage.kind === "document" ? JSON.stringify(usage.id) : "";
      return {
        title: create
          ? `Create ${usage.label}`
          : list
            ? `${usage.label} list`
            : usage.label,
        description: create
          ? "Create a document using fields from your collection schema."
          : list
            ? "Read a page of documents. Use the returned cursor for the next page."
            : "Read this document by ID (including its localized fields).",
        server: create
          ? `// Replace title with fields from your collection schema.\nconst document = await cms.api[${name}].create({\n  data: { title: "Hello" },\n  locale: ${language},\n});`
          : list
            ? `const page = await cms.api[${name}].find({\n  limit: 10, locale: ${language},\n});\n// page.docs, page.cursor, page.hasNextPage`
            : `const document = await cms.api[${name}].findById(${id}, { locale: ${language} });`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\n${
          usage.name !== usage.slug
            ? create
              ? `// Custom slugs use the HTTP path, not the local API name.\n// Replace title with fields from your collection schema.\nconst document = await client.request(${JSON.stringify(path)}, {\n  method: "POST", query: { locale: ${language} },\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify({ data: { title: "Hello" } }),\n});`
              : list
                ? `const page = await client.request(${JSON.stringify(path)}, { query: { limit: 10, locale: ${language} } });`
                : `const document = await client.request(${JSON.stringify(`${path}/${encodeURIComponent(usage.id)}`)}, { query: { locale: ${language} } });`
            : create
              ? `// Replace title with fields from your collection schema.\nconst document = await client[${name}].create({\n  data: { title: "Hello" },\n  locale: ${language},\n});`
              : list
                ? `const page = await client[${name}].find({\n  limit: 10, locale: ${language},\n});\n// Next page: client[${name}].find({ cursor: page.cursor!, limit: 10, locale: ${language} })`
                : `const document = await client[${name}].findById(${id}, { locale: ${language} });`
        }`,
      };
    }
    case "media": {
      const status = JSON.stringify(usage.status);
      return {
        title: usage.status === "active" ? "Media library" : "Unused media",
        description:
          usage.status === "active"
            ? "List files available in the library."
            : "List orphaned files awaiting reclamation or cleanup.",
        server: `const page = await cms.media.list({ status: ${status}, limit: 25 });\n// page.docs, page.cursor, page.hasNextPage`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\nconst page = await client.media.list({ status: ${status}, limit: 25 });\n// To display a file: client.media.url(page.docs[0].id)`,
      };
    }
    case "trash":
      return {
        title: "Trash",
        description: "Read deleted documents across collections, newest first.",
        server: `const page = await cms.trash.list({ limit: 25 });\n// page.entries, page.cursor, page.hasNextPage`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\nconst page = await client.trash.list({ limit: 25 });`,
      };
    case "users":
      return {
        title: "Editors",
        description:
          "List editor accounts. This is an administrative API, not public content.",
        server: `const users = await cms.auth.users.list({ limit: 25 });`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\nconst { users, totalUsers } = await client.users.list({ limit: 25 });`,
      };
    case "locales":
      return {
        title: "Languages",
        description: "Read the configured languages and the default locale.",
        server: `const locales = cms.locales.list();\nconst defaultLocale = cms._config.i18n.defaultLocale;`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\nconst client = heyoCmsClient();\nconst { locales, defaultLocale } = await client.locales.list();`,
      };
    case "keys":
      return {
        title: "Verify an API key",
        description:
          "Check a key without issuing a new one or exposing its value in a URL.",
        server: `// In trusted server code only. Never send the key to the browser.\nconst actor = await cms.auth.apiKeys.verify(process.env.HEYO_CMS_API_KEY!);\nif (!actor) throw new Error("Invalid API key");`,
        client: `import { heyoCmsClient } from "@heyo-sh/heyo-cms/client";\n\n// In server-side HTTP code (or another trusted client):\nconst client = heyoCmsClient({ token: process.env.HEYO_CMS_API_KEY! });\nconst { actor } = await client.auth.session();\nif (!actor) throw new Error("Invalid API key");`,
      };
  }
}

export function UsageHelper({ usage }: { usage: Usage }) {
  const { locale } = usePanel();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("server");
  const example = usageExample(usage, locale);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Sheet.Trigger
        render={
          <Button
            size="sm"
            shape="square"
            variant="outline"
            icon={IconCode}
            aria-label="How to use this API"
          />
        }
      />
      <Sheet.Content side="right" size="lg">
        <Sheet.Header>
          <Sheet.Title>{example.title}</Sheet.Title>
          <Sheet.Description>{example.description}</Sheet.Description>
        </Sheet.Header>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          variant="segmented"
          className="min-h-0 flex-1 gap-0"
        >
          {/* Same full-width strip and divider as the page-level tab bars. */}
          <div className="flex h-[3.0625rem] shrink-0 items-center gap-2 border-b border-heyo-hairline px-2">
            <Tabs.List
              items={[
                { value: "server", label: "Server" },
                { value: "client", label: "Client" },
              ]}
            />
          </div>
          <Sheet.Body>
            <Tabs.Panel value={tab}>
              <CodeBlock language="ts">
                {tab === "server" ? example.server : example.client}
              </CodeBlock>
            </Tabs.Panel>
          </Sheet.Body>
        </Tabs>
        <Sheet.Footer>
          <a
            href="https://heyo.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-heyo-subtle underline-offset-2 hover:text-heyo-default hover:underline"
          >
            Full Guide <IconExternalLink className="size-3" />
          </a>
        </Sheet.Footer>
      </Sheet.Content>
    </Sheet>
  );
}
