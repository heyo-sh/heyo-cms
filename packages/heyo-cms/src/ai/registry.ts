import { CmsConfigError, CmsError } from "../errors";
import { richTextFromMarkdown, richTextToMarkdown } from "../editor/index";
import type {
  AiActionContext,
  AiActionDefinition,
  AiActionOutcome,
} from "../types/ai";
import type { JsonValue } from "../types/json";

/**
 * The AI action registry.
 *
 * Section 8's rule, as code: an action is a capability a field type can
 * expose, not an item on a closed list the engine ships. `generate`,
 * `translate` and `alt` below are registered through the public
 * `defineAiAction()` — there is no private path — so a `tone-of-voice`
 * action written by an application is indistinguishable from a built-in one
 * at every point the engine touches it.
 */
const actions = new Map<string, AiActionDefinition>();

export function defineAiAction(
  definition: AiActionDefinition,
): AiActionDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) {
    throw new CmsConfigError(
      `ai.actions.${definition.id}`,
      "an action id becomes a URL segment; use lowercase letters, digits and dashes",
    );
  }
  const existing = actions.get(definition.id);
  if (existing && existing !== definition) {
    throw new CmsConfigError(
      `ai.actions.${definition.id}`,
      "a different action with this id is already registered",
    );
  }
  actions.set(definition.id, definition);
  return definition;
}

export function getAiAction(id: string): AiActionDefinition | undefined {
  return actions.get(id);
}

/** Action ids a field of this type may expose, in a stable menu order. */
export function aiActionsFor(fieldType: string): string[] {
  return [...actions.values()]
    .filter(
      (action) =>
        action.appliesTo.includes("*") || action.appliesTo.includes(fieldType),
    )
    .map((action) => action.id)
    .sort();
}

export function registeredAiActions(): string[] {
  return [...actions.keys()].sort();
}

/**
 * An action that exists only on one field.
 *
 * `field.ai` accepts a key nobody registered as long as it brings its own
 * prompt — that is what makes `ai: { "tone-of-voice": { prompt: "…" } }`
 * work without a `defineAiAction()` call. The behaviour is `generate`'s,
 * because "write this field, here is the instruction" is the only thing a
 * prompt alone can mean.
 */
export function customAiAction(id: string, prompt: string): AiActionDefinition {
  return {
    id,
    appliesTo: ["*"],
    label: id,
    prompt,
    run: (context) => writeField(context, prompt),
  };
}

// ---------------------------------------------------------------------------
// The built-in actions
// ---------------------------------------------------------------------------

const textual = ["text", "textarea", "richText", "email", "url"];

/**
 * Write the field from scratch.
 *
 * The context fields are the whole of what the model sees. That is the point
 * of `context` being per action: a title generated from the body should not
 * also be shown the internal notes, and the only way to be sure is to name
 * what travels.
 */
export const generateAction: AiActionDefinition = defineAiAction({
  id: "generate",
  appliesTo: textual,
  label: "Generate",
  prompt: "Write this field from the document below.",
  async run(context) {
    return writeField(context, promptFor(context));
  },
});

export const improveAction: AiActionDefinition = defineAiAction({
  id: "improve",
  appliesTo: textual,
  label: "Improve",
  prompt:
    "Improve the current value: keep its meaning, tighten the wording, remove filler.",
  async run(context) {
    const current = valueAsText(context);
    if (current.trim().length === 0) {
      throw CmsError.validation(
        `There is nothing in ${context.fieldName} to improve yet.`,
      );
    }
    return writeField(
      context,
      [promptFor(context), "", "Current value:", current].join("\n"),
    );
  },
});

export const summarizeAction: AiActionDefinition = defineAiAction({
  id: "summarize",
  appliesTo: textual,
  label: "Summarise",
  prompt: "Summarise the document below into this field.",
  async run(context) {
    return writeField(context, promptFor(context));
  },
});

/**
 * Translate from another locale.
 *
 * Only on a localized field, and that is checked rather than assumed: a
 * translation written into a field that stores one value for every language
 * would overwrite the original, which is the kind of data loss an editor
 * discovers a week later.
 */
export const translateAction: AiActionDefinition = defineAiAction({
  id: "translate",
  appliesTo: ["*"],
  label: "Translate",
  prompt: "Translate the value into the target language.",
  requiresLocalized: true,
  async run(context) {
    const source = valueAsText(context);
    if (source.trim().length === 0) {
      throw CmsError.validation(
        `${context.fieldName} is empty in ${context.sourceLocale ?? "the source language"}; there is nothing to translate.`,
      );
    }
    const instruction = [
      context.options.prompt ?? translateAction.prompt,
      `Source language: ${context.sourceLocale ?? "unknown"}.`,
      `Target language: ${context.locale ?? "unknown"}.`,
      "Keep formatting, links and names intact. Answer with the translation only.",
      "",
      source,
    ].join("\n");
    return writeField(context, instruction);
  },
});

/**
 * Alternative text for an image.
 *
 * The bytes are sent when the deployment can load them and the model can
 * read them; when it cannot, the action still answers from the filename and
 * the document, because a wrong-but-editable suggestion beats a button that
 * only works on some providers. The result is a suggestion either way: it
 * lands in the form, and a person approves it.
 */
export const altAction: AiActionDefinition = defineAiAction({
  id: "alt",
  appliesTo: ["media"],
  label: "Describe the image",
  prompt:
    "Write alternative text for this image: one sentence, describing what is shown, no 'image of' preamble.",
  async run(context) {
    const mediaId = typeof context.value === "string" ? context.value : null;
    if (!mediaId) {
      throw CmsError.validation(
        `${context.fieldName} has no file selected yet.`,
      );
    }
    const image = await context.loadImage(mediaId);
    const result = await context.complete({
      system: systemPrompt(context),
      prompt: [
        context.options.prompt ?? altAction.prompt,
        image === null
          ? "The image itself is not available; infer from the surrounding content."
          : "",
        contextBlock(context),
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      ...(image === null ? {} : { images: [image] }),
      ...(context.options.maxLength === undefined
        ? {}
        : { maxTokens: tokensFor(context.options.maxLength) }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    const text = oneLine(result.text);
    // The value of a `media` field is the id; alt text belongs on the file.
    // Answering with the id would be a no-op the panel would happily store.
    return { value: text, preview: text, usage: result.usage };
  },
});

/**
 * Pick values from a fixed set.
 *
 * Constrained to the declared options and filtered against them afterwards:
 * a model that invents a tag would otherwise fail validation on save, which
 * is a confusing place to learn that the suggestion was never valid.
 */
export const tagsAction: AiActionDefinition = defineAiAction({
  id: "tags",
  appliesTo: ["multiselect", "select", "relation"],
  label: "Suggest values",
  prompt: "Choose the values that fit the document below.",
  async run(context) {
    const choices = optionValues(context);
    const result = await context.complete({
      system: systemPrompt(context),
      prompt: [
        context.options.prompt ?? tagsAction.prompt,
        choices.length > 0
          ? `Choose only from: ${choices.join(", ")}.`
          : "Answer with short, lowercase values.",
        "Answer with a comma-separated list and nothing else.",
        contextBlock(context),
      ].join("\n\n"),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    const suggested = result.text
      .split(/[,\n]/)
      .map((entry) => entry.trim().replace(/^[-*]\s*/, ""))
      .filter((entry) => entry.length > 0);
    const allowed =
      choices.length === 0
        ? suggested
        : suggested.filter((entry) => choices.includes(entry));
    const value: JsonValue =
      context.field.type === "multiselect" ||
      context.field.options.many === true
        ? allowed
        : (allowed[0] ?? null);

    return {
      value,
      preview: allowed.join(", "),
      usage: result.usage,
    };
  },
});

// ---------------------------------------------------------------------------
// Shared helpers, also the worked example for a custom action
// ---------------------------------------------------------------------------

/**
 * Runs a prompt and shapes the answer for the field.
 *
 * The shaping is the part that cannot be left to the caller: a rich-text
 * field holds a ProseMirror document, so Markdown from a model has to be
 * parsed rather than stored as a string — and a single-line field has to
 * lose the newlines a model adds out of habit.
 */
async function writeField(
  context: AiActionContext,
  prompt: string,
): Promise<AiActionOutcome> {
  const result = await context.complete({
    system: systemPrompt(context),
    prompt: `${prompt}\n\n${contextBlock(context)}`.trim(),
    ...(context.options.maxLength === undefined
      ? {}
      : { maxTokens: tokensFor(context.options.maxLength) }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  const text = result.text.trim();
  if (context.field.type === "richText") {
    return {
      value: richTextFromMarkdown(text) as unknown as JsonValue,
      preview: text,
      usage: result.usage,
    };
  }

  const single = context.field.type === "textarea" ? text : oneLine(text);
  const limited =
    context.options.maxLength === undefined
      ? single
      : single.slice(0, context.options.maxLength);
  return { value: limited, preview: limited, usage: result.usage };
}

/**
 * The system prompt.
 *
 * Built from the field rather than from a global instruction, because the
 * model's job is "fill this field" and the most useful thing it can be told
 * is what the field is.
 */
export function systemPrompt(context: AiActionContext): string {
  const parts = [
    `You are an editorial assistant working inside a CMS. You are filling in the "${context.fieldName}" field of a "${context.collection.label}" document.`,
    `The field type is ${context.field.type}.`,
  ];
  if (context.field.type === "richText") {
    parts.push("Answer in Markdown. Do not wrap the answer in a code fence.");
  } else {
    parts.push("Answer with the field value only: no preamble, no quotes, no Markdown fences."); // prettier-ignore
  }
  if (context.locale) parts.push(`Write in the "${context.locale}" locale.`);
  if (context.options.maxLength !== undefined) {
    parts.push(`Stay under ${context.options.maxLength} characters.`);
  }
  return parts.join(" ");
}

/** The named context fields, rendered for a prompt. Nothing else travels. */
export function contextBlock(context: AiActionContext): string {
  const entries = Object.entries(context.context).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  if (entries.length === 0) return "";
  return entries
    .map(([name, value]) => `## ${name}\n${renderValue(value)}`)
    .join("\n\n");
}

export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  if (typeof value === "object" && (value as { type?: unknown }).type) {
    // A ProseMirror document: Markdown is both what a model reads best and
    // what it will answer in, which is what makes the round trip work.
    return richTextToMarkdown(value);
  }
  return JSON.stringify(value);
}

function promptFor(context: AiActionContext): string {
  const fallback = getAiAction(context.action)?.prompt ?? "";
  return context.options.prompt ?? fallback;
}

function valueAsText(context: AiActionContext): string {
  return renderValue(context.value);
}

function optionValues(context: AiActionContext): string[] {
  const options = context.field.options.options;
  if (!Array.isArray(options)) return [];
  return options.filter((entry): entry is string => typeof entry === "string");
}

function oneLine(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replaceAll("\n", " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Characters to tokens, roughly, with room for the model to finish a word. */
function tokensFor(characters: number): number {
  return Math.max(64, Math.ceil(characters / 3) + 32);
}
