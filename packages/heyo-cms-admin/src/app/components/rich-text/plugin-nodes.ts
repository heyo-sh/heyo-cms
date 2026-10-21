import type { EditorSchemaDescription } from "@heyo-sh/heyo-cms/types";
import { Node } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";

/**
 * Nodes a plugin registered, as TipTap extensions.
 *
 * Without this, a document written with a plugin installed loses content the
 * first time somebody opens it in the panel: ProseMirror drops a node its
 * schema does not know, the editor reports the stripped document as the
 * value, and pressing Save makes the loss permanent. That is the worst class
 * of bug a CMS can have, and it would be entirely our doing — the engine
 * stores the node happily and the serialisers render it.
 *
 * So the panel builds an extension for every node in `GET /panel`'s editor
 * schema that the built-in set does not already cover. The shape comes from
 * the same declaration the server serialises from: group, content
 * expression, attributes. Rendering is a `div` carrying the attributes
 * unless the plugin's own script registered something better — the point
 * here is that the content survives, not that it looks right.
 */

/** What TipTap's StarterKit and the panel's own extensions already provide. */
const builtIn = new Set([
  "doc",
  "text",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "image",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
]);

export function pluginNodeExtensions(
  schema: EditorSchemaDescription | undefined,
): Extensions {
  if (!schema) return [];

  return schema.nodes
    .filter((node) => !builtIn.has(node.name))
    .map((node) =>
      Node.create({
        name: node.name,
        group: node.group ?? "block",
        ...(node.content === undefined ? {} : { content: node.content }),
        inline: node.inline,
        atom: node.atom,
        // `selectable` and the default `draggable: false` are deliberate: a
        // node the panel cannot render properly should still be movable as a
        // block and deletable, which is the minimum an editor needs to
        // recover from one.
        selectable: true,
        addAttributes: () =>
          Object.fromEntries(
            Object.entries(node.attrs).map(([name, attribute]) => [
              name,
              {
                default: attribute.default ?? null,
                parseHTML: (element: HTMLElement) =>
                  element.getAttribute(`data-${name.toLowerCase()}`),
                renderHTML: (attributes: Record<string, unknown>) =>
                  attributes[name] === null || attributes[name] === undefined
                    ? {}
                    : { [`data-${name.toLowerCase()}`]: String(attributes[name]) }, // prettier-ignore
              },
            ]),
          ),
        parseHTML: () => [{ tag: `div[data-node="${node.name}"]` }],
        renderHTML: ({ HTMLAttributes }) => [
          "div",
          { ...HTMLAttributes, "data-node": node.name },
          ...(node.content === undefined || node.atom ? [] : [0]),
        ],
      }),
    );
}
