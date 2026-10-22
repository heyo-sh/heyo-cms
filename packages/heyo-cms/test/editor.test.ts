import { describe, expect, test } from "bun:test";

import {
  defineEditorNode,
  describeEditorSchema,
  registeredEditorNodes,
  renderRichText,
  richTextFromMarkdown,
  richTextToHtml,
  richTextToMarkdown,
  richTextToPlainText,
} from "../src/editor/index";
import { CmsConfigError } from "../src/errors";
import type {
  EditorNodeDefinition,
  NodeSerializerContext,
  RichTextDocument,
} from "../src/types/editor";

/**
 * Stage 9: the editor schema.
 *
 * The claim under test is the one that makes a custom node safe to ship: a
 * node cannot be registered unless it can serialise itself, so a document
 * written with a plugin installed is still readable by a consumer that has
 * never heard of the plugin. Everything else here — the Markdown round trip,
 * the unknown-node fallback — exists to keep that claim true in the two
 * places it is easy to lose: a REST response, and a prompt.
 */

const doc = (...content: unknown[]): RichTextDocument =>
  ({ type: "doc", content }) as unknown as RichTextDocument;

const text = (value: string, marks?: unknown[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

describe("the built-in nodes", () => {
  test("serialise a document to HTML, Markdown and text", () => {
    const document = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Release notes")] }, // prettier-ignore
      {
        type: "paragraph",
        content: [
          text("We shipped "),
          text("media", [{ type: "bold" }]),
          text(" and "),
          text("search", [{ type: "link", attrs: { href: "/search" } }]),
          text("."),
        ],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [text("Uploads")] }] }, // prettier-ignore
          { type: "listItem", content: [{ type: "paragraph", content: [text("Variants")] }] }, // prettier-ignore
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [text("const cms = heyoCms({});")],
      },
    );

    expect(richTextToHtml(document)).toBe(
      "<h2>Release notes</h2>" +
        '<p>We shipped <strong>media</strong> and <a href="/search">search</a>.</p>' +
        "<ul><li><p>Uploads</p></li><li><p>Variants</p></li></ul>" +
        '<pre><code class="language-ts">const cms = heyoCms({});</code></pre>',
    );

    expect(richTextToMarkdown(document)).toBe(
      [
        "## Release notes",
        "",
        "We shipped **media** and [search](/search).",
        "",
        "- Uploads\n- Variants",
        "",
        "```ts\nconst cms = heyoCms({});\n```",
      ].join("\n"),
    );

    expect(richTextToPlainText(document)).toBe(
      "Release notes\nWe shipped media and search.\nUploads\nVariants\nconst cms = heyoCms({});",
    );
  });

  test("escape what would otherwise change the structure", () => {
    const document = doc({
      type: "paragraph",
      content: [text("2 * 3 < 7 & [brackets]")],
    });
    expect(richTextToHtml(document)).toBe("<p>2 * 3 &lt; 7 &amp; [brackets]</p>"); // prettier-ignore
    expect(richTextToMarkdown(document)).toBe("2 \\* 3 < 7 & \\[brackets\\]");
  });

  test("leave code spans literal", () => {
    const document = doc({
      type: "paragraph",
      content: [text("a_b*c", [{ type: "code" }])],
    });
    expect(richTextToMarkdown(document)).toBe("`a_b*c`");
  });

  test("number an ordered list and indent what wraps", () => {
    const document = doc({
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [text("first")] }] }, // prettier-ignore
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [text("second")] },
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [text("nested")] }] }, // prettier-ignore
              ],
            },
          ],
        },
      ],
    });
    expect(richTextToMarkdown(document)).toBe(
      "3. first\n4. second\n   \n   - nested",
    );
  });

  test("resolve an image through the media id when the caller can", () => {
    const document = doc({
      type: "image",
      attrs: { mediaId: "med_1", src: "/stale", alt: "A cat" },
    });
    expect(
      renderRichText(document, {
        format: "html",
        mediaUrl: (id) => `/api/heyo-cms/media/${id}/original`,
      }),
    ).toBe(
      '<img src="/api/heyo-cms/media/med_1/original" alt="A cat" data-media-id="med_1">', // prettier-ignore
    );
    // Without a resolver the stored src is still better than nothing.
    expect(richTextToMarkdown(document)).toBe("![A cat](/stale)");
  });

  test("render the children of a node nobody has registered", () => {
    const document = doc({
      type: "calloutFromTheFuture",
      content: [{ type: "paragraph", content: [text("still my text")] }],
    });
    // Dropping it would lose content on a configuration change; keeping the
    // children keeps the author's words.
    expect(richTextToHtml(document)).toBe("<p>still my text</p>");
  });
});

describe("defineEditorNode", () => {
  test("registers a node that can render itself", () => {
    defineEditorNode({
      name: "callout",
      group: "block",
      content: "block+",
      attrs: { tone: { default: "info" } },
      toHtml: ({ node, children }) =>
        `<aside class="callout-${String(node.attrs?.tone ?? "info")}">${children}</aside>`,
      toMarkdown: ({ node, children }) =>
        `> **${String(node.attrs?.tone ?? "info")}**\n> ${children}`,
    });

    const document = doc({
      type: "callout",
      attrs: { tone: "warning" },
      content: [{ type: "paragraph", content: [text("Mind the gap")] }],
    });

    expect(richTextToHtml(document)).toBe(
      '<aside class="callout-warning"><p>Mind the gap</p></aside>',
    );
    expect(richTextToMarkdown(document)).toBe("> **warning**\n> Mind the gap");
    expect(registeredEditorNodes()).toContain("callout");
  });

  test("refuses a node that cannot be serialised", () => {
    const withoutMarkdown = {
      name: "mystery",
      toHtml: (context: NodeSerializerContext) => context.children,
    };
    expect(() =>
      defineEditorNode(withoutMarkdown as unknown as EditorNodeDefinition),
    ).toThrow(CmsConfigError);

    const withoutHtml = {
      name: "mystery",
      toMarkdown: (context: NodeSerializerContext) => context.children,
    };
    expect(() =>
      defineEditorNode(withoutHtml as unknown as EditorNodeDefinition),
    ).toThrow(/toHtml/);
  });

  test("refuses a second, different node with the same name", () => {
    const first = { name: "widget", toHtml: () => "", toMarkdown: () => "" };
    defineEditorNode(first);
    defineEditorNode(first); // the same object is idempotent
    expect(
      () =>
      defineEditorNode({ name: "widget", toHtml: () => "!", toMarkdown: () => "!" }), // prettier-ignore
    ).toThrow(/already registered/);
  });

  test("describes the schema as data the panel can build from", () => {
    const schema = describeEditorSchema();
    const heading = schema.nodes.find((node) => node.name === "heading");
    expect(heading).toEqual({
      name: "heading",
      group: "block",
      content: "inline*",
      inline: false,
      atom: false,
      attrs: { level: { default: 1 } },
      component: false,
    });
    expect(schema.marks.map((mark) => mark.name)).toContain("link");
  });
});

describe("Markdown back into a document", () => {
  test("parses the block grammar the serialiser emits", () => {
    const markdown = [
      "# Title",
      "",
      "A paragraph with **bold**, *italic* and a [link](https://heyo.sh).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
    ].join("\n");

    const document = richTextFromMarkdown(markdown);
    const types = (document.content as { type: string }[]).map(
      (node) => node.type,
    );
    expect(types).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);

    // The round trip is the property that matters: a model answers in
    // Markdown, the editor opens a document, and nothing is lost in between.
    expect(richTextToMarkdown(document)).toBe(markdown);
  });

  test("keeps task lists and their state", () => {
    const document = richTextFromMarkdown("- [x] done\n- [ ] todo");
    expect(richTextToMarkdown(document)).toBe("- [x] done\n- [ ] todo");
    expect(richTextToHtml(document)).toContain('data-type="taskItem"');
  });

  test("unescapes what the serialiser escaped", () => {
    const document = richTextFromMarkdown("2 \\* 3 and \\[brackets\\]");
    expect(richTextToPlainText(document)).toBe("2 * 3 and [brackets]");
  });

  test("answers with an empty paragraph rather than nothing", () => {
    expect(richTextFromMarkdown("   ")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    } as unknown as RichTextDocument);
  });
});
