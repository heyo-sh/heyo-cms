import { richTextToMarkdown } from "../editor/index";
import type { AiActionContext, AiActionOutcome, AiUsage } from "../types/ai";
import type { JsonObject, JsonValue } from "../types/json";

/** Translate prose in place, leaving the rich-text tree (including media IDs,
 * links, marks and plugin nodes) intact. Markdown round-tripping the entire
 * document would silently turn an image with a mediaId into a plain URL. */
export async function translateVariantRichText(
  context: AiActionContext,
): Promise<AiActionOutcome> {
  const usage: AiUsage = { input: 0, output: 0, total: 0, cost: 0 };
  const translate = async (value: string): Promise<string> => {
    if (!value.trim()) return value;
    const response = await context.complete({
      system:
        "Translate CMS text. Answer with the translation only, without quotes or a preamble. Keep names, placeholders and URLs intact.",
      prompt: `Translate from ${context.sourceLocale} to ${context.locale}. This text belongs to the ${context.fieldName} field:\n\n${value}`,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    usage.input += response.usage.input;
    usage.output += response.usage.output;
    usage.total += response.usage.total;
    usage.cost += response.usage.cost;
    const text = response.text.trim();
    if (!text)
      throw new Error(
        `AI returned an empty translation for ${context.fieldName}.`,
      );
    // ProseMirror sometimes stores leading/trailing whitespace in its own
    // text nodes. Do not let trimming in a model collapse adjacent words.
    return `${value.match(/^\s*/)?.[0] ?? ""}${text}${value.match(/\s*$/)?.[0] ?? ""}`;
  };

  const walk = async (node: JsonValue): Promise<JsonValue> => {
    if (Array.isArray(node)) {
      const children: JsonValue[] = [];
      for (const child of node) children.push(await walk(child));
      return children;
    }
    if (!node || typeof node !== "object") return node;
    const result: JsonObject = { ...node };
    if (node.type === "text" && typeof node.text === "string") {
      result.text = await translate(node.text);
    }
    if (
      node.type === "image" &&
      node.attrs &&
      typeof node.attrs === "object" &&
      !Array.isArray(node.attrs)
    ) {
      const attrs: JsonObject = { ...node.attrs };
      for (const key of ["alt", "title"]) {
        if (typeof attrs[key] === "string")
          attrs[key] = await translate(attrs[key]);
      }
      result.attrs = attrs;
    }
    if (Array.isArray(node.content)) result.content = await walk(node.content);
    return result;
  };

  const value = await walk(context.value);
  return {
    value,
    preview: richTextToMarkdown(value),
    usage,
  };
}
