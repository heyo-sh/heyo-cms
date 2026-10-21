import type { RichTextDocument, RichTextMark, RichTextNode } from "../types/editor"; // prettier-ignore

/**
 * Markdown back into a ProseMirror document.
 *
 * The AI runtime needs this and nothing else does yet: a model is shown a
 * field as Markdown, because that is the format every model writes well, and
 * what comes back has to become a document the editor can open. Without the
 * parser the only honest options would be inserting the raw Markdown as
 * literal text — which is what every CMS that bolts AI onto rich text gets
 * wrong — or refusing AI on rich-text fields.
 *
 * It is deliberately a small parser: the block grammar the serialiser in this
 * directory emits, plus the inline marks. Anything it does not recognise
 * stays as text, which is the failure mode that loses nothing.
 */
export function richTextFromMarkdown(markdown: string): RichTextDocument {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const content = parseBlocks(lines);
  return {
    type: "doc",
    content: (content.length > 0
      ? content
      : [{ type: "paragraph" }]) as unknown as RichTextDocument["content"],
  } as unknown as RichTextDocument;
}

/** A plain string as one paragraph per blank-line-separated chunk. */
export function richTextFromText(text: string): RichTextDocument {
  const paragraphs = text
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  return {
    type: "doc",
    content: (paragraphs.length === 0
      ? [{ type: "paragraph" }]
      : paragraphs.map((chunk) => ({
          type: "paragraph",
          content: [{ type: "text", text: chunk }],
        }))) as unknown as RichTextDocument["content"],
  } as unknown as RichTextDocument;
}

function parseBlocks(lines: string[]): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = /^\s*(`{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const language = (fence[2] ?? "").trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith(marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      nodes.push({
        type: "codeBlock",
        ...(language.length > 0 ? { attrs: { language } } : {}),
        ...(body.length > 0
          ? { content: [{ type: "text", text: body.join("\n") }] }
          : {}),
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push({
        type: "heading",
        attrs: { level: (heading[1] as string).length },
        content: parseInline((heading[2] as string).trim()),
      });
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push({ type: "blockquote", content: parseBlocks(quoted) });
      continue;
    }

    if (listMarker(line)) {
      const [list, next] = parseList(lines, index);
      nodes.push(list);
      index = next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim().length === 0 ||
        listMarker(current) ||
        /^(#{1,6})\s/.test(current) ||
        /^\s*>/.test(current) ||
        /^\s*`{3,}/.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    // A hard break inside a paragraph is Markdown's two trailing spaces; the
    // join keeps the lines together and the parser above already trimmed
    // them, so a wrapped paragraph becomes one paragraph rather than several.
    nodes.push({
      type: "paragraph",
      content: parseInline(paragraph.join(" ")),
    });
  }

  return nodes;
}

interface ListMarker {
  ordered: boolean;
  task: boolean | null;
  indent: number;
  text: string;
  start: number;
}

function listMarker(line: string): ListMarker | null {
  const bullet = /^(\s*)[-*+]\s+(\[([ xX])\]\s+)?(.*)$/.exec(line);
  if (bullet) {
    const checkbox = bullet[3];
    return {
      ordered: false,
      task: checkbox === undefined ? null : checkbox.toLowerCase() === "x",
      indent: (bullet[1] ?? "").length,
      text: bullet[4] ?? "",
      start: 1,
    };
  }
  const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ordered) {
    return {
      ordered: true,
      task: null,
      indent: (ordered[1] ?? "").length,
      text: ordered[3] ?? "",
      start: Number(ordered[2] ?? 1),
    };
  }
  return null;
}

function parseList(lines: string[], from: number): [RichTextNode, number] {
  const first = listMarker(lines[from] ?? "");
  if (!first) return [{ type: "paragraph" }, from + 1];

  const items: RichTextNode[] = [];
  let index = from;

  while (index < lines.length) {
    const marker = listMarker(lines[index] ?? "");
    if (!marker || marker.indent !== first.indent) break;
    if (marker.ordered !== first.ordered) break;
    if ((marker.task === null) !== (first.task === null)) break;

    const body = [marker.text];
    index += 1;
    // Continuation lines belong to the item: indented text, and nested lists,
    // which recurse through `parseBlocks` with their indentation removed.
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim().length === 0) break;
      const nested = listMarker(next);
      if (nested && nested.indent <= first.indent) break;
      if (!nested && next.search(/\S/) <= first.indent) break;
      body.push(next.slice(first.indent + 2));
      index += 1;
    }

    items.push({
      type: first.task === null ? "listItem" : "taskItem",
      ...(marker.task === null ? {} : { attrs: { checked: marker.task } }),
      content: parseBlocks(body),
    });
  }

  const type =
    first.task !== null
      ? "taskList"
      : first.ordered
        ? "orderedList"
        : "bulletList";

  return [
    {
      type,
      ...(type === "orderedList" && first.start !== 1
        ? { attrs: { start: first.start } }
        : {}),
      content: items,
    },
    index,
  ];
}

/**
 * Inline marks.
 *
 * One pass, longest marker first, so `**bold**` is not read as two italics.
 * Escapes written by the serialiser (`\*`) are unescaped here, which is what
 * makes a round trip through a model lossless for ordinary prose.
 */
function parseInline(text: string): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer.length === 0) return;
    nodes.push({ type: "text", text: buffer });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    if (rest.startsWith("\\") && rest.length > 1) {
      buffer += rest[1];
      index += 2;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/.exec(rest);
    if (link) {
      flush();
      const image = index > 0 && text[index - 1] === "!";
      if (image) {
        // `![alt](src)` — the `!` is already in the buffer, so it has to go.
        nodes.push({
          type: "image",
          attrs: { src: link[2] ?? "", alt: link[1] ?? "" },
        });
        const last = nodes.at(-2);
        if (last?.type === "text" && last.text?.endsWith("!")) {
          last.text = last.text.slice(0, -1);
        }
      } else {
        nodes.push({
          type: "text",
          text: link[1] ?? "",
          marks: [{ type: "link", attrs: { href: link[2] ?? "" } }],
        });
      }
      index += link[0].length;
      continue;
    }

    const emphasis = matchEmphasis(rest);
    if (emphasis) {
      flush();
      for (const child of parseInline(emphasis.inner)) {
        nodes.push(withMark(child, emphasis.mark));
      }
      index += emphasis.length;
      continue;
    }

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push({
        type: "text",
        text: code[1] ?? "",
        marks: [{ type: "code" }],
      });
      index += code[0].length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return nodes;
}

interface Emphasis {
  mark: RichTextMark;
  inner: string;
  length: number;
}

function matchEmphasis(rest: string): Emphasis | null {
  const patterns: [RegExp, RichTextMark][] = [
    [/^\*\*\*([^*]+)\*\*\*/, { type: "bold" }],
    [/^\*\*([^*]+)\*\*/, { type: "bold" }],
    [/^__([^_]+)__/, { type: "bold" }],
    [/^~~([^~]+)~~/, { type: "strike" }],
    [/^\*([^*]+)\*/, { type: "italic" }],
    [/^_([^_]+)_/, { type: "italic" }],
  ];
  for (const [pattern, mark] of patterns) {
    const match = pattern.exec(rest);
    if (match) {
      return {
        mark,
        inner: match[1] ?? "",
        length: match[0].length,
      };
    }
  }
  return null;
}

function withMark(node: RichTextNode, mark: RichTextMark): RichTextNode {
  if (node.type !== "text") return node;
  return { ...node, marks: [...(node.marks ?? []), mark] };
}
