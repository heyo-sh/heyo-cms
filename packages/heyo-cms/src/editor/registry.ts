import { CmsConfigError } from "../errors";
import type {
  EditorMarkDefinition,
  EditorNodeDefinition,
  EditorSchemaDescription,
} from "../types/editor";

/**
 * The editor registry.
 *
 * Module-level, like the field registry, and for the same reason: a node is
 * declared where it is written — at the top level of a plugin or an
 * application module — and the configuration that uses it has no way to see
 * the declaration. The alternative, passing nodes through `heyoCms()`, would
 * make a node unusable by the serialisers a CLI or a job calls without a
 * configuration in hand.
 */
const nodes = new Map<string, EditorNodeDefinition>();
const marks = new Map<string, EditorMarkDefinition>();

/**
 * Declares a node of the rich-text schema.
 *
 * The serialisers are not optional, and that is the whole point of the
 * function (stage 9). A node without them renders in the panel and nowhere
 * else: `GET /posts/1` answers with a shape no consumer knows, and the
 * promise that the REST API is usable without a frontend quietly stops being
 * true. Refusing at registration makes that failure a start-up error in the
 * plugin that caused it, naming the plugin, instead of a rendering bug in
 * somebody else's site.
 */
export function defineEditorNode(
  definition: EditorNodeDefinition,
): EditorNodeDefinition {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(definition.name)) {
    throw new CmsConfigError(
      `editor.nodes.${definition.name}`,
      "a node name must be letters, digits and underscores, starting with a letter",
    );
  }
  if (typeof definition.toHtml !== "function") {
    throw new CmsConfigError(
      `editor.nodes.${definition.name}`,
      "needs a toHtml serialiser; a node that cannot render as HTML is a node the REST API cannot answer with",
    );
  }
  if (typeof definition.toMarkdown !== "function") {
    throw new CmsConfigError(
      `editor.nodes.${definition.name}`,
      "needs a toMarkdown serialiser; Markdown is what exports and AI prompts speak",
    );
  }

  const existing = nodes.get(definition.name);
  if (existing && existing !== definition) {
    throw new CmsConfigError(
      `editor.nodes.${definition.name}`,
      "a different node with this name is already registered",
    );
  }
  nodes.set(definition.name, definition);
  return definition;
}

/** Declares a mark. Same contract, one fewer dimension. */
export function defineEditorMark(
  definition: EditorMarkDefinition,
): EditorMarkDefinition {
  if (
    typeof definition.toHtml !== "function" ||
    typeof definition.toMarkdown !== "function"
  ) {
    throw new CmsConfigError(
      `editor.marks.${definition.name}`,
      "needs both a toHtml and a toMarkdown serialiser",
    );
  }
  const existing = marks.get(definition.name);
  if (existing && existing !== definition) {
    throw new CmsConfigError(
      `editor.marks.${definition.name}`,
      "a different mark with this name is already registered",
    );
  }
  marks.set(definition.name, definition);
  return definition;
}

export function getEditorNode(name: string): EditorNodeDefinition | undefined {
  return nodes.get(name);
}

export function getEditorMark(name: string): EditorMarkDefinition | undefined {
  return marks.get(name);
}

export function registeredEditorNodes(): string[] {
  return [...nodes.keys()].sort();
}

export function registeredEditorMarks(): string[] {
  return [...marks.keys()].sort();
}

/**
 * The schema as data, for the panel and for `cms.inspect()`.
 *
 * Serialisers and components are dropped: one is a closure and the other is
 * a React component, and neither survives JSON. What crosses is exactly what
 * TipTap needs to build a schema — names, groups, content expressions,
 * attribute defaults — so a plugin's node renders in a bundle compiled before
 * the plugin existed.
 */
export function describeEditorSchema(): EditorSchemaDescription {
  return {
    nodes: [...nodes.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((node) => ({
        name: node.name,
        ...(node.group === undefined ? {} : { group: node.group }),
        ...(node.content === undefined ? {} : { content: node.content }),
        inline: node.inline === true,
        atom: node.atom === true,
        attrs: node.attrs ?? {},
        ...(node.marks === undefined ? {} : { marks: node.marks }),
        component: node.Component !== undefined,
      })),
    marks: [...marks.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((mark) => ({ name: mark.name, attrs: mark.attrs ?? {} })),
  };
}
