import type { EditorMarkDefinition, EditorNodeDefinition } from "../types/editor"; // prettier-ignore
import { defineEditorMark, defineEditorNode } from "./registry";
import {
  escapeHtml,
  htmlAttributes,
  indentContinuation,
  stringAttr,
} from "./serialize";

/**
 * The nodes TipTap's starter kit produces, declared through the public API.
 *
 * Every one of them goes through `defineEditorNode()` — no shortcut, no
 * internal map a built-in gets to use and a plugin does not. That is the same
 * rule the field registry follows, and for the same reason: an extension
 * point that the product itself bypasses is an extension point nobody can
 * trust (stage 9).
 *
 * The serialisers below are therefore also the worked examples. A plugin
 * adding a `callout` writes exactly this much code.
 */

export const docNode: EditorNodeDefinition = defineEditorNode({
  name: "doc",
  content: "block+",
  toHtml: ({ children }) => children,
  toMarkdown: ({ children }) => children,
});

export const paragraphNode: EditorNodeDefinition = defineEditorNode({
  name: "paragraph",
  group: "block",
  content: "inline*",
  toHtml: ({ children }) => `<p>${children}</p>`,
  // An empty paragraph is a deliberate blank line in the editor; in Markdown
  // it is nothing at all, and emitting `\n\n` for it would double every gap.
  toMarkdown: ({ children }) => children,
});

export const headingNode: EditorNodeDefinition = defineEditorNode({
  name: "heading",
  group: "block",
  content: "inline*",
  attrs: { level: { default: 1 } },
  toHtml: ({ node, children }) => {
    const level = headingLevel(node.attrs?.level);
    return `<h${level}>${children}</h${level}>`;
  },
  toMarkdown: ({ node, children }) =>
    `${"#".repeat(headingLevel(node.attrs?.level))} ${children}`,
});

export const blockquoteNode: EditorNodeDefinition = defineEditorNode({
  name: "blockquote",
  group: "block",
  content: "block+",
  toHtml: ({ children }) => `<blockquote>${children}</blockquote>`,
  toMarkdown: ({ children }) =>
    children
      .split("\n")
      .map((line) => (line.length === 0 ? ">" : `> ${line}`))
      .join("\n"),
});

export const bulletListNode: EditorNodeDefinition = defineEditorNode({
  name: "bulletList",
  group: "block",
  content: "listItem+",
  toHtml: ({ children }) => `<ul>${children}</ul>`,
  toMarkdown: ({ childStrings }) =>
    childStrings.map((item) => `- ${indentContinuation(item, 2)}`).join("\n"),
});

export const orderedListNode: EditorNodeDefinition = defineEditorNode({
  name: "orderedList",
  group: "block",
  content: "listItem+",
  attrs: { start: { default: 1 } },
  toHtml: ({ node, children }) => {
    const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
    return `<ol${start === 1 ? "" : ` start="${start}"`}>${children}</ol>`;
  },
  toMarkdown: ({ node, childStrings }) => {
    const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
    return childStrings
      .map((item, index) => {
        const marker = `${start + index}. `;
        return `${marker}${indentContinuation(item, marker.length)}`;
      })
      .join("\n");
  },
});

export const listItemNode: EditorNodeDefinition = defineEditorNode({
  name: "listItem",
  content: "paragraph block*",
  toHtml: ({ children }) => `<li>${children}</li>`,
  toMarkdown: ({ children }) => children,
});

export const taskListNode: EditorNodeDefinition = defineEditorNode({
  name: "taskList",
  group: "block",
  content: "taskItem+",
  toHtml: ({ children }) => `<ul data-type="taskList">${children}</ul>`,
  toMarkdown: ({ childStrings }) => childStrings.join("\n"),
});

export const taskItemNode: EditorNodeDefinition = defineEditorNode({
  name: "taskItem",
  content: "paragraph block*",
  attrs: { checked: { default: false } },
  toHtml: ({ node, children }) =>
    `<li data-type="taskItem"${htmlAttributes({ "data-checked": node.attrs?.checked === true })}>${children}</li>`,
  toMarkdown: ({ node, children }) =>
    `- [${node.attrs?.checked === true ? "x" : " "}] ${indentContinuation(children, 6)}`,
});

export const codeBlockNode: EditorNodeDefinition = defineEditorNode({
  name: "codeBlock",
  group: "block",
  content: "text*",
  marks: "",
  attrs: { language: { default: null } },
  toHtml: ({ node, childNodes }) => {
    const language = stringAttr(node, "language");
    const code = escapeHtml(rawText(childNodes));
    const className = language ? ` class="language-${escapeHtml(language)}"` : ""; // prettier-ignore
    return `<pre><code${className}>${code}</code></pre>`;
  },
  toMarkdown: ({ node, childNodes }) => {
    const language = stringAttr(node, "language") ?? "";
    // A fence long enough to survive code that contains backticks: three is
    // the minimum, and one more than the longest run inside is the rule.
    const code = rawText(childNodes);
    const longest = Math.max(
      0,
      ...[...code.matchAll(/`+/g)].map((match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${code}\n${fence}`;
  },
  toText: ({ childNodes }) => rawText(childNodes),
});

export const horizontalRuleNode: EditorNodeDefinition = defineEditorNode({
  name: "horizontalRule",
  group: "block",
  atom: true,
  toHtml: () => "<hr>",
  toMarkdown: () => "---",
  toText: () => "",
});

export const hardBreakNode: EditorNodeDefinition = defineEditorNode({
  name: "hardBreak",
  group: "inline",
  inline: true,
  atom: true,
  toHtml: () => "<br>",
  toMarkdown: () => "  \n",
  toText: () => "\n",
});

/**
 * An image, by media id.
 *
 * `mediaId` is the attribute the lifecycle counts (section 6): a bare `src`
 * is a URL, and a URL is not a reference. The serialiser prefers a resolved
 * URL when the caller can provide one and falls back to the stored `src`,
 * because a document exported from a CLI still has to render somewhere.
 */
export const imageNode: EditorNodeDefinition = defineEditorNode({
  name: "image",
  group: "block",
  atom: true,
  attrs: {
    src: { default: null },
    alt: { default: null },
    title: { default: null },
    mediaId: { default: null },
  },
  toHtml: ({ node, mediaUrl }) => {
    const source = resolveSource(node.attrs, mediaUrl);
    return `<img${htmlAttributes({
      src: source,
      alt: stringAttr(node, "alt") ?? "",
      title: stringAttr(node, "title"),
      "data-media-id": stringAttr(node, "mediaId"),
    })}>`;
  },
  toMarkdown: ({ node, mediaUrl }) => {
    const source = resolveSource(node.attrs, mediaUrl) ?? "";
    const alt = stringAttr(node, "alt") ?? "";
    const title = stringAttr(node, "title");
    return `![${alt}](${source}${title ? ` "${title}"` : ""})`;
  },
  toText: ({ node }) => stringAttr(node, "alt") ?? "",
});

export const tableNode: EditorNodeDefinition = defineEditorNode({
  name: "table",
  group: "block",
  content: "tableRow+",
  toHtml: ({ children }) => `<table><tbody>${children}</tbody></table>`,
  /**
   * GitHub-flavoured Markdown, with a header row invented when there is none.
   *
   * A table without the separator line is not a table in Markdown at all; it
   * renders as one run-on paragraph. Treating the first row as the header is
   * what every editor does on paste, and it is the only lossless-enough
   * answer that keeps the output a table.
   */
  toMarkdown: ({ childStrings }) => {
    const [header, ...rest] = childStrings;
    if (header === undefined) return "";
    const columns = header.split(" | ").length;
    const divider = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
    return [`| ${header} |`, divider, ...rest.map((row) => `| ${row} |`)].join(
      "\n",
    );
  },
});

export const tableRowNode: EditorNodeDefinition = defineEditorNode({
  name: "tableRow",
  content: "(tableCell | tableHeader)*",
  toHtml: ({ children }) => `<tr>${children}</tr>`,
  toMarkdown: ({ childStrings }) =>
    childStrings.map((cell) => cell.replaceAll("\n", " ")).join(" | "),
});

export const tableHeaderNode: EditorNodeDefinition = defineEditorNode({
  name: "tableHeader",
  content: "block+",
  attrs: {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
  },
  toHtml: ({ node, children }) => `<th${spanAttributes(node.attrs)}>${children}</th>`, // prettier-ignore
  toMarkdown: ({ children }) => children,
});

export const tableCellNode: EditorNodeDefinition = defineEditorNode({
  name: "tableCell",
  content: "block+",
  attrs: {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
  },
  toHtml: ({ node, children }) => `<td${spanAttributes(node.attrs)}>${children}</td>`, // prettier-ignore
  toMarkdown: ({ children }) => children,
});

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export const boldMark: EditorMarkDefinition = defineEditorMark({
  name: "bold",
  toHtml: ({ text }) => `<strong>${text}</strong>`,
  toMarkdown: ({ text }) => `**${text}**`,
});

export const italicMark: EditorMarkDefinition = defineEditorMark({
  name: "italic",
  toHtml: ({ text }) => `<em>${text}</em>`,
  toMarkdown: ({ text }) => `*${text}*`,
});

export const underlineMark: EditorMarkDefinition = defineEditorMark({
  name: "underline",
  toHtml: ({ text }) => `<u>${text}</u>`,
  // Markdown has no underline. `<u>` is valid Markdown-embedded HTML and
  // survives every renderer; inventing `__text__` would mean bold somewhere.
  toMarkdown: ({ text }) => `<u>${text}</u>`,
});

export const strikeMark: EditorMarkDefinition = defineEditorMark({
  name: "strike",
  toHtml: ({ text }) => `<s>${text}</s>`,
  toMarkdown: ({ text }) => `~~${text}~~`,
});

export const codeMark: EditorMarkDefinition = defineEditorMark({
  name: "code",
  toHtml: ({ text }) => `<code>${text}</code>`,
  toMarkdown: ({ text }) => `\`${text}\``,
});

export const linkMark: EditorMarkDefinition = defineEditorMark({
  name: "link",
  attrs: { href: { default: null }, target: { default: null }, rel: { default: null } }, // prettier-ignore
  toHtml: ({ mark, text }) =>
    `<a${htmlAttributes({
      href: mark.attrs?.href ?? "",
      target: mark.attrs?.target,
      rel: mark.attrs?.rel,
    })}>${text}</a>`,
  toMarkdown: ({ mark, text }) =>
    `[${text}](${String(mark.attrs?.href ?? "")})`,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headingLevel(value: unknown): number {
  const level = typeof value === "number" ? Math.trunc(value) : 1;
  return Math.min(6, Math.max(1, level));
}

function rawText(nodes: { text?: string; content?: unknown }[]): string {
  return nodes.map((node) => node.text ?? "").join("");
}

function spanAttributes(attrs: Record<string, unknown> | undefined): string {
  const colspan = attrs?.colspan;
  const rowspan = attrs?.rowspan;
  return htmlAttributes({
    colspan: typeof colspan === "number" && colspan > 1 ? colspan : undefined,
    rowspan: typeof rowspan === "number" && rowspan > 1 ? rowspan : undefined,
  });
}

function resolveSource(
  attrs: Record<string, unknown> | undefined,
  mediaUrl: ((id: string) => string | null) | undefined,
): string | undefined {
  const id = attrs?.mediaId;
  if (typeof id === "string" && mediaUrl) {
    const resolved = mediaUrl(id);
    if (resolved) return resolved;
  }
  const src = attrs?.src;
  return typeof src === "string" ? src : undefined;
}
