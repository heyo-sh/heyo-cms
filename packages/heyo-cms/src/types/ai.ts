import type { Actor, OperationSource } from "./actor";
import type { AiAuth } from "./config";
import type { ResolvedCollection } from "./config";
import type { AiModelRef, FieldAiAction, FieldDefinition } from "./fields";
import type { JsonObject, JsonValue } from "./json";

/**
 * The AI runtime (stage 9, section 8).
 *
 * Two rules from the plan are expressed as types here rather than as
 * documentation:
 *
 * 1. **AI is a capability of a field.** There is no global task list. A run
 *    is addressed by collection, field and action, and the action has to be
 *    a key of `field.ai` or the request is refused — a field without the key
 *    has no AI at all, not a hidden one.
 * 2. **Nothing is written.** `run()` answers with a value; storing it is an
 *    ordinary update that the editor triggers, with the same hooks, access
 *    control and validation as typing it by hand. Autosave was ruled out, and
 *    a model writing silently would be worse than autosave.
 */

/** What one call to a model cost, carried into `ai.task.completed`. */
export interface AiUsage {
  input: number;
  output: number;
  total: number;
  /** In US dollars, as the provider catalogue prices it. `0` when unknown. */
  cost: number;
}

/** An image handed to a vision model: the bytes, not a URL it cannot fetch. */
export interface AiImageInput {
  contentType: string;
  data: Uint8Array;
}

export interface AiCompletionRequest {
  model: AiModelRef;
  auth: AiAuth;
  system: string;
  prompt: string;
  /** Sent with the prompt. `alt` is the reason this exists. */
  images?: AiImageInput[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiCompletionResult {
  text: string;
  usage: AiUsage;
}

/**
 * How a prompt reaches a model.
 *
 * pi is the default implementation and is loaded lazily, so a deployment
 * without AI never pays for the import and a Worker bundle does not carry a
 * provider catalogue it will not call. Overriding it is the supported way to
 * put a proxy, a self-hosted model or a test double in the path — the same
 * escape hatch `uploads.images.processor` gives the image pipeline.
 */
export type AiCompletionFn = (
  request: AiCompletionRequest,
) => Promise<AiCompletionResult>;

/**
 * What an action implementation is handed.
 *
 * `complete` is already bound to the resolved model and credentials, so an
 * action never sees a token and cannot pick a different provider than the
 * one the configuration resolved for it.
 */
export interface AiActionContext {
  /** The action key as it appears in `field.ai`. */
  action: string;
  /** The field's current value in this locale, as stored. */
  value: JsonValue;
  field: FieldDefinition;
  fieldName: string;
  collection: ResolvedCollection;
  /** Only the fields the action's `context` named, already resolved. */
  context: JsonObject;
  /** The whole document as the caller supplied it, for actions that need it. */
  document: JsonObject;
  locale: string | null;
  /** The locale a `translate` action is translating from. */
  sourceLocale: string | null;
  /** The action's configuration: prompt, label, model, maxLength. */
  options: FieldAiAction;
  model: AiModelRef;
  actor: Actor | null;
  complete: (
    request: Omit<AiCompletionRequest, "model" | "auth">,
  ) => Promise<AiCompletionResult>;
  /**
   * The bytes of a stored file, for an action that needs to look at one.
   *
   * `null` when there is no `uploads` section, when the id does not resolve,
   * or when the file is not an image — an action is expected to degrade to
   * what it can infer from the document rather than fail.
   */
  loadImage: (mediaId: string) => Promise<AiImageInput | null>;
  signal?: AbortSignal;
}

export interface AiActionOutcome {
  /** What the panel will offer to insert. Shaped for the field type. */
  value: JsonValue;
  /** The same thing as text, for a preview and for the activity log. */
  preview: string;
  usage: AiUsage;
}

/**
 * A registered AI action.
 *
 * `appliesTo` is the list of field types the action may be configured on;
 * `"*"` means any. It is checked when the configuration is built, so a
 * `translate` on a number is a start-up error rather than a button that
 * fails on click.
 */
export interface AiActionDefinition {
  id: string;
  appliesTo: string[];
  label: string;
  /** Used when the field's action does not bring its own. */
  prompt: string;
  /** Instruction prepended to every run of this action. */
  system?: string;
  /** `true` refuses the action on a field that is not localized. */
  requiresLocalized?: boolean;
  run: (context: AiActionContext) => Promise<AiActionOutcome>;
}

export interface AiRunArgs {
  collection: string;
  field: string;
  action: string;
  /** The stored document, when there is one. Omitted for an unsaved draft. */
  id?: string;
  /**
   * The form as it stands in the browser.
   *
   * Merged over the stored document, because the editor is asking about what
   * they are looking at: generating a title from a body that was saved ten
   * minutes ago would answer a question nobody asked.
   */
  document?: JsonObject;
  locale?: string;
  /** Where a `translate` reads from. Defaults to `i18n.defaultLocale`. */
  sourceLocale?: string;
  /** Internal variant workflow: translate localized text even without a field menu action. */
  variantTranslation?: boolean;
  actor?: Actor | null;
  source?: OperationSource;
  signal?: AbortSignal;
}

export interface AiRunResult {
  collection: string;
  field: string;
  action: string;
  value: JsonValue;
  preview: string;
  model: AiModelRef;
  usage: AiUsage;
}

// ---------------------------------------------------------------------------
// The global assistant
// ---------------------------------------------------------------------------

/**
 * Which screen the editor is looking at.
 *
 * A hint and nothing more. The server resolves slugs against configuration,
 * validates tabs, and re-reads documents through `cms.api` with the session's
 * actor. Media metadata is public by design. A forged hint cannot grant
 * permission, but may point at another *accessible* record, so it never
 * replaces the editor's actual request or the tool's access checks.
 */
export type AiPageContextKind =
  | "dashboard"
  | "collection-list"
  | "document"
  | "global"
  | "media"
  | "trash"
  | "settings";

export interface AiPageContext {
  kind: AiPageContextKind;
  collectionSlug?: string;
  documentId?: string;
  /**
   * The file the media screen's details pane is showing.
   *
   * Separate from `documentId` because it resolves somewhere else entirely —
   * through `cms.media`, not through a collection — and a single field would
   * make "this" ambiguous on the one screen where both could be meant.
   */
  mediaId?: string;
  /**
   * Which sub-surface of the screen is in front.
   *
   * A document with two rich-text fields is two tabs, and "rewrite this
   * section" means the one the editor is looking at. The same field carries
   * the settings tab and the media library's status tab: an opaque string,
   * because the panel owns those names and the engine only ever repeats them
   * back to the model.
   */
  tab?: string;
  locale?: string;
  /**
   * Fields the open form has changed and not saved.
   *
   * Only the names — never the values. The draft itself stays in the browser
   * in v1: sending it would leak unsaved text to a provider and would let the
   * agent write a document the form is about to overwrite. What the names buy
   * is the refusal: the assistant declines to write a record whose form is
   * dirty and asks the editor to save or discard first.
   */
  dirtyFields?: string[];
  /** The revision the open form was loaded from. */
  baselineRevision?: number;
}

export interface AiAssistantTurn {
  role: "user" | "assistant";
  text: string;
}

/** What a mutation touched, in the shape the panel needs to go there. */
export interface AiMutationTarget {
  kind: "document" | "global" | "media";
  collection?: string;
  collectionSlug?: string;
  id: string;
  locale?: string | null;
  revision?: number;
}

/**
 * A plan, as the panel may see it.
 *
 * Enough to decide with — how many records, which fields, what will happen —
 * and nothing the model wrote that could pass for an instruction. The values
 * themselves are summarised rather than dumped: an approval dialog is a place
 * to confirm an intention, not to review a diff of twelve thousand
 * characters.
 */
export interface AiPlanOperationSummary {
  action:
    | "create"
    | "update"
    | "trash"
    | "restore"
    | "purge"
    | "update-global"
    | "update-media";
  target: AiMutationTarget;
  label: string;
  fields: string[];
}

export interface AiPlanSummary {
  id: string;
  runId: string;
  summary: string;
  operations: AiPlanOperationSummary[];
  /** ISO. The plan is refused after it, and is not silently renewed. */
  expiresAt: string;
}

/**
 * What the panel is told while a run is in flight.
 *
 * Deliberately ours rather than pi's event stream. The agent library's events
 * are its internal contract and change with its minor versions; this one is
 * the public shape the panel is written against, and it carries only what a
 * human is allowed to see — a tool's *summary*, never its arguments or its
 * raw result.
 */
export type AiAssistantEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; id: string; label: string }
  | { type: "tool-end"; id: string; summary: string }
  | {
      type: "mutation-applied";
      runId: string;
      target: AiMutationTarget;
      fields: string[];
    }
  | { type: "approval-required"; plan: AiPlanSummary }
  | { type: "done"; runId: string; usage: AiUsage }
  | { type: "error"; code: string; message: string };

export interface AiAssistantArgs {
  /** Groups the turns of one conversation. Opaque to the engine. */
  conversationId?: string;
  message: string;
  history?: AiAssistantTurn[];
  pageContext?: AiPageContext;
  locale?: string;
  actor?: Actor | null;
  source?: OperationSource;
  signal?: AbortSignal;
}

export interface AiApprovePlanArgs {
  planId: string;
  actor?: Actor | null;
  source?: OperationSource;
  signal?: AbortSignal;
}

export interface AiApprovePlanResult {
  planId: string;
  runId: string;
  applied: {
    target: AiMutationTarget;
    fields: string[];
  }[];
}

/**
 * A provider's credentials, as the panel may see them.
 *
 * Never the token. `configured` says whether a key exists and `source` says
 * where it came from, which is everything a settings screen needs and
 * nothing an attacker can use.
 */
export interface AiProviderStatus {
  provider: string;
  configured: boolean;
  source: "config" | "database" | null;
  type: AiAuth["type"] | null;
  /** Last four characters of a stored key, so it can be recognised. */
  hint: string | null;
  updatedAt: string | null;
  /** Models the provider catalogue knows, when it is loadable. */
  models?: string[];
}

export interface AiCredentialArgs {
  provider: string;
  token: string;
  actor?: Actor | null;
  source?: OperationSource;
}

/** `cms.ai`. Present whether or not `ai` is configured, like `cms.media`. */
export interface CmsAi {
  /** Whether an `ai` section exists at all. */
  readonly enabled: boolean;
  /** Whether `ai.assistant` is configured and switched on. */
  readonly assistantEnabled: boolean;
  /** Action ids registered for a field type, in menu order. */
  actions(fieldType: string): string[];
  run(args: AiRunArgs): Promise<AiRunResult>;
  /**
   * The panel-wide agent.
   *
   * An async iterable rather than a promise because the interesting part of a
   * run is what happens during it: the editor has to see which record was
   * read and which field was written while it happens, and a run that only
   * reported its result would be a progress spinner with a paragraph at the
   * end.
   */
  runAssistant(args: AiAssistantArgs): AsyncIterable<AiAssistantEvent>;
  /**
   * Executes a stored plan after a human approved it.
   *
   * The plan is replayed from the row, exactly as it was shown. It is never
   * handed back to the model to reconstruct — an approval has to mean the
   * thing on the screen, not a second generation that resembles it.
   */
  approveAssistantPlan(args: AiApprovePlanArgs): Promise<AiApprovePlanResult>;
  providers(): Promise<AiProviderStatus[]>;
  /** Stores a provider key in the database, encrypted. */
  setCredential(args: AiCredentialArgs): Promise<AiProviderStatus>;
  removeCredential(args: {
    provider: string;
    actor?: Actor | null;
  }): Promise<boolean>;
}
