import type { ComponentType, JsonObject, JsonValue } from "./json";

/**
 * The editor contract (stage 9).
 *
 * A rich-text field holds a ProseMirror document, which is JSON and therefore
 * storable anywhere, and useless to anybody who cannot render it. That is the
 * problem this file exists to prevent: a custom node that only the panel
 * understands turns `GET /posts/1` into a tree of unknown shapes, and every
 * consumer — a static site, an RSS feed, an AI prompt — has to reimplement it.
 *
 * So a node is not registered unless it can serialise itself. `toHtml` and
 * `toMarkdown` are required properties of `defineEditorNode()`, not optional
 * conveniences, and the registry refuses a definition that lacks either.
 */

/** A mark on a text node: `bold`, `link`, a custom one. */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

/**
 * One node of a ProseMirror document.
 *
 * Deliberately permissive: the engine stores whatever the editor produced,
 * including nodes this deployment has never heard of, because refusing to
 * store an unknown node would make an editor upgrade a data migration.
 */
export interface RichTextNode {
  type: string;
  attrs?: Record<string, JsonValue>;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
}

/** The value a `richText()` field holds. `{ type: "doc", content: [...] }`. */
export interface RichTextDocument extends JsonObject {
  type: string;
}

/**
 * What a serialiser is handed.
 *
 * `children` is the already-serialised content of the node, so a definition
 * never walks the tree itself — which is what keeps a third-party node from
 * having to know how the rest of the document is rendered.
 */
export interface NodeSerializerContext {
  node: RichTextNode;
  /** The serialised children, joined by the default rule for the format. */
  children: string;
  /** The same children unjoined, for a list that has to number them. */
  childStrings: string[];
  /** The nodes' own children, for a definition that needs their shape. */
  childNodes: RichTextNode[];
  /** How deep the node sits. A list item uses it for indentation. */
  depth: number;
  /** Zero-based position among its siblings. An ordered list uses it. */
  index: number;
  /**
   * Resolves a media id to a URL, when the caller knows how.
   *
   * Optional because the same document is serialised in places that cannot
   * reach the database — a CLI export, a prompt — and a node that cannot
   * resolve a file is expected to fall back to whatever `src` it carries.
   */
  mediaUrl?: (id: string) => string | null;
}

export type NodeSerializer = (context: NodeSerializerContext) => string;

export interface MarkSerializerContext {
  mark: RichTextMark;
  /** The text the mark wraps, already escaped for the target format. */
  text: string;
}

export type MarkSerializer = (context: MarkSerializerContext) => string;

/**
 * A node type, as `defineEditorNode()` registers it.
 *
 * `schema` is the ProseMirror node spec. It travels to the panel as data so
 * the editor can build its schema at runtime, which is the only way one
 * static bundle can serve a deployment that installed a plugin yesterday.
 */
export interface EditorNodeDefinition {
  name: string;
  /** `block`, `inline`, or a custom group a parent's `content` can name. */
  group?: string;
  /** ProseMirror content expression, e.g. `"inline*"` or `"block+"`. */
  content?: string;
  inline?: boolean;
  /** A node with no editable content of its own: an image, a divider. */
  atom?: boolean;
  /** Attribute names and their defaults. Serialisable, so the panel gets them. */
  attrs?: Record<string, { default?: JsonValue }>;
  /** Marks allowed inside. `""` forbids all of them. */
  marks?: string;
  /** Required. A node that cannot render as HTML is a node a REST client cannot use. */
  toHtml: NodeSerializer;
  /** Required, for the same reason: Markdown is what an AI prompt and an export speak. */
  toMarkdown: NodeSerializer;
  /** Plain text, for search indexes and excerpts. Defaults to the children. */
  toText?: NodeSerializer;
  /** The panel's React component for a node view. Never imported by the core. */
  Component?: ComponentType<Record<string, unknown>>;
}

export interface EditorMarkDefinition {
  name: string;
  attrs?: Record<string, { default?: JsonValue }>;
  toHtml: MarkSerializer;
  toMarkdown: MarkSerializer;
}

/** What `renderRichText()` produces. */
export type RichTextFormat = "html" | "markdown" | "text";

export interface RenderRichTextOptions {
  format: RichTextFormat;
  mediaUrl?: (id: string) => string | null;
}

/** The node and mark registry, as `cms.inspect()` and the panel read it. */
export interface EditorSchemaDescription {
  nodes: {
    name: string;
    group?: string;
    content?: string;
    inline: boolean;
    atom: boolean;
    attrs: Record<string, { default?: JsonValue }>;
    marks?: string;
    /** Whether a plugin registered a component for the panel to render. */
    component: boolean;
  }[];
  marks: {
    name: string;
    attrs: Record<string, { default?: JsonValue }>;
  }[];
}
