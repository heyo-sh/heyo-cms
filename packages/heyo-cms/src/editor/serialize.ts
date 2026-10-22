import type {
  RenderRichTextOptions,
  RichTextDocument,
  RichTextFormat,
  RichTextMark,
  RichTextNode,
} from "../types/editor";
import type { JsonValue } from "../types/json";
import { getEditorMark, getEditorNode } from "./registry";

/**
 * Turning a stored document into something a consumer can use.
 *
 * The walker is here and the formatting is in the node definitions, which is
 * the split that makes a third-party node a first-class one: a definition
 * receives its children already serialised and decides how to wrap them, and
 * never has to know how the rest of the tree is rendered (stage 9).
 *
 * An unknown node — one written by an editor that had a plugin this
 * deployment does not — renders its children rather than disappearing. A
 * paragraph inside a node nobody recognises is still the author's text, and
 * dropping it would lose content on a configuration change.
 */

export function renderRichText(
  value: unknown,
  options: RenderRichTextOptions,
): string {
  if (!isNode(value)) return "";
  const output = serializeNode(value, {
    format: options.format,
    index: 0,
    depth: 0,
    ...(options.mediaUrl === undefined ? {} : { mediaUrl: options.mediaUrl }),
  });
  return options.format === "html" ? output : output.trim();
}

export function richTextToHtml(
  value: unknown,
  options: Omit<RenderRichTextOptions, "format"> = {},
): string {
  return renderRichText(value, { ...options, format: "html" });
}

export function richTextToMarkdown(
  value: unknown,
  options: Omit<RenderRichTextOptions, "format"> = {},
): string {
  return renderRichText(value, { ...options, format: "markdown" });
}

/**
 * Text with no markup at all.
 *
 * What a search index, an excerpt and a token budget want: three uses that
 * would each otherwise strip HTML with a regular expression.
 */
export function richTextToPlainText(
  value: unknown,
  options: Omit<RenderRichTextOptions, "format"> = {},
): string {
  return renderRichText(value, { ...options, format: "text" });
}

interface WalkOptions {
  format: RichTextFormat;
  index: number;
  depth: number;
  mediaUrl?: (id: string) => string | null;
}

function serializeNode(node: RichTextNode, options: WalkOptions): string {
  const { format } = options;

  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks ?? [], format);
  }

  const childNodes = node.content ?? [];
  const childStrings = childNodes.map((child, index) =>
    serializeNode(child, { ...options, index, depth: options.depth + 1 }),
  );
  const children = joinChildren(childNodes, childStrings, format);

  const definition = getEditorNode(node.type);
  if (!definition) return children;

  const serializer =
    format === "html"
      ? definition.toHtml
      : format === "markdown"
        ? definition.toMarkdown
        : (definition.toText ?? ((context) => context.children));

  return serializer({
    node,
    children,
    childStrings,
    childNodes,
    depth: options.depth,
    index: options.index,
    ...(options.mediaUrl === undefined ? {} : { mediaUrl: options.mediaUrl }),
  });
}

/**
 * How sibling output is glued together.
 *
 * HTML needs nothing — the tags carry the structure. The text formats need
 * blank lines between blocks and nothing between inline runs, which is the
 * difference between a readable Markdown export and one long paragraph.
 */
function joinChildren(
  childNodes: RichTextNode[],
  childStrings: string[],
  format: RichTextFormat,
): string {
  if (format === "html") return childStrings.join("");
  const block = childNodes.some((child) => isBlock(child));
  if (!block) return childStrings.join("");
  const separator = format === "markdown" ? "\n\n" : "\n";
  return childStrings.filter((value) => value.length > 0).join(separator);
}

function isBlock(node: RichTextNode): boolean {
  if (node.type === "text") return false;
  const definition = getEditorNode(node.type);
  if (!definition) return true;
  return definition.inline !== true;
}

/**
 * Marks, innermost first.
 *
 * `code` is the exception that has to be handled rather than configured: its
 * content is literal, so escaping it would put backslashes in the output of
 * every code span.
 */
function applyMarks(
  text: string,
  marks: RichTextMark[],
  format: RichTextFormat,
): string {
  const literal = marks.some((mark) => mark.type === "code");
  let output =
    format === "html"
      ? escapeHtml(text)
      : format === "markdown" && !literal
        ? escapeMarkdown(text)
        : text;

  if (format === "text") return output;

  for (const mark of marks) {
    const definition = getEditorMark(mark.type);
    if (!definition) continue;
    const serializer =
      format === "html" ? definition.toHtml : definition.toMarkdown;
    output = serializer({ mark, text: output });
  }
  return output;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Escaping for Markdown, deliberately minimal.
 *
 * Only the characters that would otherwise change the structure of the
 * document. Escaping more produces output full of backslashes, which is
 * worse than the rare literal asterisk it protects.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]])/g, "\\$1");
}

/** `<a href="x" rel="y">`, with empty attributes dropped. */
export function htmlAttributes(
  attributes: Record<string, JsonValue | undefined>,
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) {
      parts.push(` ${name}`);
      continue;
    }
    parts.push(` ${name}="${escapeHtml(String(value))}"`);
  }
  return parts.join("");
}

/** Indents every line but the first: Markdown's rule for nested blocks. */
export function indentContinuation(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value.split("\n").join(`\n${pad}`);
}

export function attr(node: RichTextNode, name: string): JsonValue | undefined {
  return node.attrs?.[name];
}

export function stringAttr(
  node: RichTextNode,
  name: string,
): string | undefined {
  const value = attr(node, name);
  return typeof value === "string" ? value : undefined;
}

function isNode(value: unknown): value is RichTextDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
