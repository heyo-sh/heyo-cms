import { Type } from "typebox";

import { permits } from "../../access/permissions";
import { CmsError } from "../../errors";
import { and, eq, like, or } from "../../query";
import type { Actor } from "../../types/actor";
import type { AiMutationTarget } from "../../types/ai";
import type { CollectionApi, GlobalApi } from "../../types/api";
import type { ResolvedCmsConfig, ResolvedCollection } from "../../types/config";
import type { CmsInstance } from "../../types/instance";
import type { JsonObject, JsonValue } from "../../types/json";
import type { MediaDocument } from "../../types/media";
import { localeFor, requireCollection, type ResolvedPageContext } from "./context"; // prettier-ignore
import {
  maxPlanOperations,
  planSummary,
  PlanStore,
  type PlanOperation,
} from "./plans";
import {
  describeCmsFor,
  mayReadField,
  mayWriteField,
  titleField,
  type AssistantSchema,
} from "./schema";
import { toolText, type AgentTool } from "./runtime";
import {
  fallbackFields,
  fieldExcerpts,
  recordSummary,
  recordTitle,
  renderRecord,
  shapeFieldValue,
  type RelationTitle,
} from "./values";

/** A find never answers with more than this, whatever the model asked for. */
const maxSearchResults = 20;
/** How many matches a search reads before ranking them. */
const maxSearchCandidates = 50;
/** Fields a search may hand back per result. */
const maxListedFields = 5;
/** The audit trail is paged; one tool call sees one small page of it. */
const maxActivityResults = 25;

/**
 * Said in every approval tool's description, because that is what a model
 * reads at the moment it decides whether to call: a model left to itself asks
 * "shall I delete it?" first, and the editor ends up saying yes twice — once
 * in the chat and again on the card.
 */
const callAtOnce =
  "Call it as soon as you know which record and what change: the card is how the editor confirms, so do not ask them first whether you should.";

/**
 * What a tool is allowed to change about the run around it.
 *
 * Narrow on purpose. A tool may read the configuration, call the instance,
 * announce a mutation and park a plan. It cannot reach the transport, the
 * conversation, the model or the system prompt — which is what makes "the
 * record said to ignore previous instructions" a sentence in a tool result
 * rather than a privilege escalation.
 */
export interface ToolContext {
  config: ResolvedCmsConfig;
  cms: CmsInstance;
  actor: Actor | null;
  page: ResolvedPageContext;
  runId: string;
  plans: PlanStore;
  /** Announced to the panel the moment a write commits. */
  onMutation: (target: AiMutationTarget, fields: string[]) => void;
  /**
   * A plan that needs a human. The run announces it once the answer is out,
   * not at this moment.
   */
  onPlan: (plan: ReturnType<typeof planSummary>) => void;
  /**
   * Spent by every tool call; the server's budget, not the model's. The
   * approval tools say they are a `"proposal"`: a run that has run out of
   * steps may still make one of those, because it writes nothing.
   */
  spend: (kind?: "proposal") => void;
  signal?: AbortSignal | undefined;
  /**
   * The revision of every record this run has read, by `revisionKey`.
   *
   * Revisions are the server's bookkeeping, and the model never sees one. It
   * used to: every read answered with `revision`, every write asked for
   * `expectedRevision`, and the model dutifully reported "saved, revision 3"
   * to editors who had no idea what that was. Now a read records the
   * revision here and a write is made against it — so a write still fails
   * if somebody saved after the model read, and a record the model never
   * read cannot be written at all.
   */
  revisions?: Map<string, number>;
  /**
   * The documents this run has saved directly, by `documentKey`. The first
   * one is a save; a second, different one is refused towards a plan.
   */
  savedDocuments?: Set<string>;
}

export function createAssistantTools(given: ToolContext): AgentTool[] {
  const context: ToolContext = {
    ...given,
    revisions: given.revisions ?? new Map(),
    savedDocuments: given.savedDocuments ?? new Set(),
  };
  const tools: AgentTool[] = [
    describeCmsTool(context),
    currentPageTool(context),
    findDocumentsTool(context),
    getDocumentTool(context),
    updateDocumentTool(context),
    createDocumentTool(context),
    trashDocumentTool(context),
    restoreDocumentTool(context),
    getGlobalTool(context),
    updateGlobalTool(context),
    createPlanTool(context),
  ];

  if (context.config.uploads !== undefined) {
    tools.push(findMediaTool(context), getMediaTool(context), updateMediaTool(context)); // prettier-ignore
  }
  tools.push(getActivityTool(context));
  return tools;
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

function describeCmsTool(context: ToolContext): AgentTool {
  let cached: AssistantSchema | undefined;

  return {
    name: "describe_cms",
    label: "Read the project schema",
    description:
      "Lists the collections, globals and fields this account can see, with types, options, relation targets and whether each field is writable. Call this before reading or changing anything.",
    parameters: Type.Object({}),
    async execute() {
      context.spend();
      cached ??= describeCmsFor(
        context.config,
        context.actor,
        localeCodes(context.cms),
      );
      return toolText(JSON.stringify(cached));
    },
  };
}

/**
 * What the editor is looking at, re-read rather than repeated.
 *
 * The shape is deliberately uneven. A document screen answers with the
 * record; a list answers with the collection and an explicit "there is no
 * single record here", because the failure this tool exists to prevent is a
 * model that invents one. The open tab and the selected file travel for the
 * same reason: on a document with two writing surfaces, or a media screen
 * with a details pane open, "this" has an answer the panel already knows and
 * the model would otherwise have to ask for.
 */
function currentPageTool(context: ToolContext): AgentTool {
  return {
    name: "get_current_page",
    label: "Read the current page",
    description:
      'What the editor is looking at right now. Use this for "this article", "this image", "here", "the current page". Returns the screen, the open tab, and the record or file it is showing.',
    parameters: Type.Object({}),
    async execute() {
      context.spend();
      const page = context.page;
      const base: JsonObject = {
        screen: page.kind,
        locale: page.locale,
        ...(page.tab === null ? {} : { tab: page.tab }),
        ...(page.collection === null
          ? {}
          : {
              collection: page.collection.name,
              collectionLabel: page.collection.label,
            }),
        ...(page.dirtyFields.length === 0
          ? {}
          : { unsavedFields: page.dirtyFields }),
      };
      // Appended rather than assigned: a new form that is being typed into is
      // both "nothing exists yet" and "do not write this", and a later note
      // overwriting an earlier one would drop whichever happened to be
      // written first.
      const answer = (payload: JsonObject): ReturnType<typeof toolText> =>
        toolText(JSON.stringify(withNotes(base, payload, page.dirtyFields)));

      if (page.kind === "media") {
        return answer(await describeMediaPage(context));
      }

      if (page.collection === null) {
        return answer({
          note: "This screen is not about one record. Ask the editor which one they mean, or search for it.",
        });
      }

      if (page.kind === "collection-list") {
        return answer({
          note: `The editor is looking at a list of ${page.collection.label}, not at one record. Use find_documents in "${page.collection.name}" to choose one, and ask if more than one matches.`,
        });
      }

      if (page.kind === "global") {
        const document = await readGlobal(
          context,
          page.collection,
          page.locale,
          { forDisplay: true },
        );
        remember(context, globalKey(page.collection), document.revision);
        return answer({
          global: page.collection.name,
          record: renderRecord(
            page.collection,
            document,
            readableFields(page.collection, context.actor, page.locale),
            relationTitle(context),
          ),
        });
      }

      if (page.kind !== "document") return answer({});

      // A form that has never been saved. Saying so is the whole value of
      // the answer: the model otherwise looks for an id, and the honest reply
      // to "polish this" here is "paste it in or save it first".
      if (page.documentId === null) {
        return answer({
          documentId: null,
          note: `The editor is filling in a new ${page.collection.label} that has not been created yet. There is no record to read or update. Do not guess an id; if they want it written, propose a create_document with the values they gave you.`,
        });
      }

      // Re-read through the instance with the session's actor. The id from
      // the browser is a pointer, never an authorisation.
      const document = await readDocument(
        context,
        page.collection,
        page.documentId,
        page.locale,
        { forDisplay: true },
      );
      remember(context, documentKey(page.collection, document.id), document.revision); // prettier-ignore
      return answer({
        documentId: String(document.id),
        record: renderRecord(
          page.collection,
          document,
          readableFields(page.collection, context.actor, page.locale),
          relationTitle(context),
        ),
      });
    },
  };
}

/**
 * The screen, its answer, and every note that applies to both.
 *
 * `note` is the field the model actually acts on, so the ones that matter
 * have to survive being combined: "there are unsaved changes here" and "this
 * record does not exist yet" are both true of a new form being typed into,
 * and either of them alone produces a wrong next step.
 */
function withNotes(
  base: JsonObject,
  payload: JsonObject,
  dirtyFields: string[],
): JsonObject {
  const notes = [
    ...(dirtyFields.length === 0
      ? []
      : [
          "The editor has unsaved changes in this form. Do not write this record until they save or discard them.",
        ]),
    ...(typeof payload.note === "string" ? [payload.note] : []),
  ];
  return {
    ...base,
    ...payload,
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
  };
}

/**
 * The media screen, with whatever the details pane is showing.
 *
 * Re-read through `cms.media` rather than trusting the browser's metadata.
 * Media reads are public by design (including the REST endpoints), unlike
 * document reads, which use the run's actor. A pane that is closed answers
 * with the library and says there is no
 * file selected, which is a better prompt than silence for "change the alt
 * text of this".
 */
async function describeMediaPage(context: ToolContext): Promise<JsonObject> {
  // A context can name a screen this deployment does not have. Answering
  // "there is no media here" is cheaper than letting `cms.media` raise a 501
  // the model will read as a transient failure and retry.
  if (context.config.uploads === undefined) {
    return {
      note: "This deployment has no uploads configured; there is no media library to look at.",
    };
  }

  const id = context.page.mediaId;
  if (id === null) {
    return {
      note: "The editor is in the media library with no file selected. Use find_media to choose one, or ask which file they mean.",
    };
  }

  const file = await context.cms.media.get(id);
  if (!file) {
    return {
      note: `The file the editor had open (${id}) is no longer readable. Ask which file they mean.`,
    };
  }
  return {
    mediaId: file.id,
    file: {
      ...mediaSummary(file),
      status: file.status,
      // The whole map, as `get_media` answers it: alt text is localized, and
      // showing one language would have the model overwrite the others.
      alt: file.alt,
    },
    note: 'This is the file "this image" refers to. update_media changes its filename or alt text; the bytes are never touched.',
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function findDocumentsTool(context: ToolContext): AgentTool {
  return {
    name: "find_documents",
    label: "Search documents",
    description: `Finds documents in one collection, most recently updated first. Without a query it lists the collection (use offset to page), with one it matches any of its words in the text fields. Returns ids, titles, a one-line gist, the total count, and which fields have no translation in the locale — never the full record. To check or compare a few fields across many records (which ones lack an SEO description, which are drafts), name them in fields and they come back, shortened, for every result: one call instead of a read per record. Read one in full with get_document. At most ${maxSearchResults} per call.`,
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      query: Type.Optional(Type.String({ maxLength: 200 })),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSearchResults })), // prettier-ignore
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      fields: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
          maxItems: maxListedFields,
        }),
      ),
      includeTrashed: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, parameters) {
      context.spend();
      const input = parameters as {
        collection: string;
        query?: string;
        locale?: string;
        limit?: number;
        offset?: number;
        fields?: string[];
        includeTrashed?: boolean;
      };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      const locale = localeFor(context.config, context.page, input.locale);
      const limit = Math.min(input.limit ?? 10, maxSearchResults);
      const title = titleField(collection);

      const offset = input.offset ?? 0;
      const listed = (input.fields ?? []).map((name) => {
        // The same refusal as a patch: a field that does not exist and one
        // this account may not read are indistinguishable from here.
        if (
          !(name in collection.fields) ||
          !mayReadField(collection, name, context.actor, locale)
        ) {
          throw CmsError.validation(
            `"${name}" is not a field of ${collection.name}. Call describe_cms and use a field that exists.`,
          );
        }
        return name;
      });
      const search = where(collection, input.query, context.actor, locale);
      const page = await collectionApi(context, collection).find({
        actor: context.actor,
        locale,
        // A search reads a wider window and ranks it; the database only
        // knows "matches any word", and the newest of those is rarely the
        // best of them.
        limit: search ? maxSearchCandidates : limit,
        // A real count, not the length of this page: "how many posts do we
        // have" was otherwise answered with the page size.
        count: true,
        ...(offset > 0 ? { offset } : {}),
        ...(input.includeTrashed === true ? { includeTrashed: true } : {}),
        ...(search ? { where: search.where } : {}),
      });
      const docs = search
        ? rank(page.docs, search.patterns, search.fields, title).slice(0, limit)
        : page.docs;

      if (docs.length === 0) {
        return toolText(
          `No ${collection.label} matched${input.query ? ` "${input.query}"` : ""}${offset > 0 ? ` past the first ${offset}` : ""}.`,
        );
      }

      return toolText(
        JSON.stringify({
          collection: collection.name,
          locale,
          total: page.totalDocs ?? docs.length,
          returned: docs.length,
          offset,
          hasMore: (page.totalDocs ?? 0) > offset + docs.length || page.hasNextPage, // prettier-ignore
          results: docs.map((document) => {
            const untranslated = Object.keys(fallbackFields(document));
            remember(context, documentKey(collection, document.id), document.revision); // prettier-ignore
            return {
              id: String(document.id),
              title: recordTitle(document, title),
              summary: recordSummary(
                collection,
                document,
                title ? [title] : [],
              ),
              ...(listed.length === 0
                ? {}
                : { fields: fieldExcerpts(collection, document, listed) }),
              ...(untranslated.length === 0 ? {} : { untranslated }),
              ...(document.deletedAt === null ? {} : { trashed: true }),
            };
          }),
        }),
      );
    },
  };
}

function getDocumentTool(context: ToolContext): AgentTool {
  return {
    name: "get_document",
    label: "Read a document",
    description:
      "Reads one document in one locale. Rich text comes back as Markdown. Read a document before you change it.",
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      id: Type.String({ minLength: 1, maxLength: 200 }),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
    }),
    async execute(_id, parameters) {
      context.spend();
      const input = parameters as {
        collection: string;
        id: string;
        locale?: string;
      };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      const locale = localeFor(context.config, context.page, input.locale);
      const document = await readDocument(
        context,
        collection,
        input.id,
        locale,
        { forDisplay: true },
      );
      const visible = readableFields(collection, context.actor, locale);
      remember(context, documentKey(collection, document.id), document.revision); // prettier-ignore

      return toolText(
        JSON.stringify({
          collection: collection.name,
          id: String(document.id),
          locale,
          writableFields: visible.filter((name) =>
            mayWriteField(collection, name, context.actor, locale),
          ),
          record: renderRecord(
            collection,
            document,
            visible,
            relationTitle(context),
          ),
        }),
      );
    },
  };
}

/**
 * The one tool that writes without asking.
 *
 * Changing a field on an existing record the editor named is the operation
 * they asked for — "edit and save" means edit and save, and a diff they have
 * to apply by hand is the old document chat this replaced. Everything else —
 * creating, deleting, restoring, touching more than one record — goes through
 * a plan, because those are the operations where "not quite what I meant" is
 * expensive and an undo is not available.
 *
 * Four things are checked before the write, in this order: the form is not
 * dirty, the fields exist and are writable, the values are shaped, and the
 * revision still matches. All four are refusals the agent can read and act on.
 */
function updateDocumentTool(context: ToolContext): AgentTool {
  return {
    name: "update_document",
    label: "Save changes to a document",
    description:
      "Writes a patch to one existing document and saves it. Only the named fields change. The document has to have been read in this conversation first (get_document, get_current_page or find_documents); the save is refused if somebody changed it since. Rich-text fields take Markdown. One record per request: when several records change, put them all in create_mutation_plan instead.",
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      id: Type.String({ minLength: 1, maxLength: 200 }),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
      data: Type.Record(Type.String(), Type.Any()),
    }),
    async execute(toolCallId, parameters) {
      context.spend();
      const input = parameters as {
        collection: string;
        id: string;
        /** Not offered to the model; honoured from a caller that has one. */
        expectedRevision?: number;
        locale?: string;
        data: JsonObject;
      };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      const locale = localeFor(context.config, context.page, input.locale);
      const key = documentKey(collection, input.id);
      assertOneRecord(context, key);
      assertFormIsClean(context, collection, input.id);
      const data = shapePatch(collection, input.data, context.actor, locale);
      const expectedRevision = revisionFor(context, key, input.expectedRevision); // prettier-ignore

      const updated = await collectionApi(context, collection).update({
        id: input.id,
        data,
        actor: context.actor,
        source: "ai",
        locale,
        runId: context.runId,
        expectedRevision,
        idempotencyKey: `${context.runId}:${toolCallId}`,
      });

      if (updated === null) {
        return toolText(
          "A before-hook on this collection stopped the change. Nothing was written.",
        );
      }

      const fields = Object.keys(data);
      const target: AiMutationTarget = {
        kind: "document",
        collection: collection.name,
        collectionSlug: collection.slug,
        id: String(updated.id),
        locale,
        revision: Number(updated.revision ?? 0),
      };
      context.onMutation(target, fields);
      context.savedDocuments?.add(key);
      // The model's next change to the same record builds on this one.
      remember(context, key, updated.revision);

      return toolText(
        JSON.stringify({
          saved: true,
          collection: collection.name,
          id: String(updated.id),
          locale,
          fields,
        }),
      );
    },
  };
}

function createDocumentTool(context: ToolContext): AgentTool {
  return {
    name: "create_document",
    label: "Propose a new document",
    description: `Prepares a new document and shows it to the editor as a card with Approve and Dismiss buttons. Nothing is written until they approve. ${callAtOnce}`,
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
      data: Type.Record(Type.String(), Type.Any()),
    }),
    async execute(_id, parameters) {
      context.spend("proposal");
      const input = parameters as {
        collection: string;
        locale?: string;
        data: JsonObject;
      };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      await assertMayOperate(context, collection, "create");
      const locale = localeFor(context.config, context.page, input.locale);
      const data = shapePatch(collection, input.data, context.actor, locale);

      return park(context, {
        kind: "create",
        summary: `Create one ${collection.label}`,
        operations: [
          {
            action: "create",
            collection: collection.name,
            locale,
            data,
            label: `New ${collection.label}`,
            fields: Object.keys(data),
          },
        ],
      });
    },
  };
}

function trashDocumentTool(context: ToolContext): AgentTool {
  return {
    name: "trash_document",
    label: "Propose moving a document to the trash",
    description: `Shows the editor a card with Approve and Dismiss buttons for moving one document to the trash. Nothing is deleted until they approve. ${callAtOnce}`,
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      id: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    async execute(_id, parameters) {
      context.spend("proposal");
      const input = parameters as { collection: string; id: string };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      // Checked now, not at approval time. A plan the actor could never
      // execute is a button that fails on click, and the failure would arrive
      // after they had already decided to trust it.
      await assertMayOperate(context, collection, "delete");
      // Read it too, so the approval screen shows the title the editor knows
      // the record by rather than an id they have to look up.
      const document = await readDocument(
        context,
        collection,
        input.id,
        context.page.locale,
      );

      return park(context, {
        kind: "trash",
        summary: `Move one ${collection.label} to the trash`,
        operations: [
          {
            action: "trash",
            collection: collection.name,
            id: String(document.id),
            expectedRevision: Number(document.revision ?? 1),
            label: recordTitle(document, titleField(collection)),
            fields: [],
          },
        ],
      });
    },
  };
}

function restoreDocumentTool(context: ToolContext): AgentTool {
  return {
    name: "restore_document",
    label: "Propose restoring a document",
    description: `Shows the editor a card with Approve and Dismiss buttons for bringing one trashed document back. ${callAtOnce}`,
    parameters: Type.Object({
      collection: Type.String({ minLength: 1, maxLength: 120 }),
      id: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    async execute(_id, parameters) {
      context.spend("proposal");
      const input = parameters as { collection: string; id: string };
      const collection = requireCollection(
        context.config,
        input.collection,
        "collection",
      );
      await assertMayOperate(context, collection, "update");

      return park(context, {
        kind: "restore",
        summary: `Restore one ${collection.label}`,
        operations: [
          {
            action: "restore",
            collection: collection.name,
            id: input.id,
            label: input.id,
            fields: [],
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

function getGlobalTool(context: ToolContext): AgentTool {
  return {
    name: "get_global",
    label: "Read a global",
    description: "Reads one singleton (site-wide settings) in one locale.",
    parameters: Type.Object({
      global: Type.String({ minLength: 1, maxLength: 120 }),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
    }),
    async execute(_id, parameters) {
      context.spend();
      const input = parameters as { global: string; locale?: string };
      const global = requireCollection(context.config, input.global, "global");
      const locale = localeFor(context.config, context.page, input.locale);
      const document = await readGlobal(context, global, locale, {
        forDisplay: true,
      });
      const visible = readableFields(global, context.actor, locale);
      remember(context, globalKey(global), document.revision);

      return toolText(
        JSON.stringify({
          global: global.name,
          locale,
          writableFields: visible.filter((name) =>
            mayWriteField(global, name, context.actor, locale),
          ),
          record: renderRecord(
            global,
            document,
            visible,
            relationTitle(context),
          ),
        }),
      );
    },
  };
}

function updateGlobalTool(context: ToolContext): AgentTool {
  return {
    name: "update_global",
    label: "Save changes to a global",
    description:
      "Writes a patch to one singleton and saves it. Read it with get_global first; the save is refused if somebody changed it since.",
    parameters: Type.Object({
      global: Type.String({ minLength: 1, maxLength: 120 }),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
      data: Type.Record(Type.String(), Type.Any()),
    }),
    async execute(toolCallId, parameters) {
      context.spend();
      const input = parameters as {
        global: string;
        /** Not offered to the model; honoured from a caller that has one. */
        expectedRevision?: number;
        locale?: string;
        data: JsonObject;
      };
      const global = requireCollection(context.config, input.global, "global");
      const locale = localeFor(context.config, context.page, input.locale);
      assertFormIsClean(context, global, null);
      const data = shapePatch(global, input.data, context.actor, locale);
      const key = globalKey(global);
      const expectedRevision = revisionFor(context, key, input.expectedRevision); // prettier-ignore

      const updated = await globalApi(context, global).update({
        data,
        actor: context.actor,
        source: "ai",
        locale,
        runId: context.runId,
        expectedRevision,
        idempotencyKey: `${context.runId}:${toolCallId}`,
      });

      if (updated === null) {
        return toolText(
          "A before-hook stopped the change. Nothing was written.",
        );
      }

      const fields = Object.keys(data);
      context.onMutation(
        {
          kind: "global",
          collection: global.name,
          collectionSlug: global.slug,
          id: String(updated.id),
          locale,
          revision: Number(updated.revision ?? 0),
        },
        fields,
      );

      remember(context, key, updated.revision);

      return toolText(
        JSON.stringify({
          saved: true,
          global: global.name,
          locale,
          fields,
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function findMediaTool(context: ToolContext): AgentTool {
  return {
    name: "find_media",
    label: "Search the media library",
    description:
      "Finds files by filename, type or status. Defaults to the media tab the editor is viewing, if any. Metadata only — the bytes of a file are never readable from here.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      mimeType: Type.Optional(Type.String({ maxLength: 120 })),
      status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("orphaned")])), // prettier-ignore
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSearchResults })), // prettier-ignore
    }),
    async execute(_id, parameters) {
      context.spend();
      const input = parameters as {
        query?: string;
        mimeType?: string;
        status?: "active" | "orphaned";
        limit?: number;
      };
      const status =
        input.status ??
        (context.page.kind === "media" && context.page.tab === "orphaned"
          ? "orphaned"
          : undefined);
      const result = await context.cms.media.list({
        actor: context.actor,
        limit: Math.min(input.limit ?? 10, maxSearchResults),
        ...(input.query === undefined ? {} : { search: input.query }),
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        ...(status === undefined ? {} : { status }),
      });

      return toolText(
        JSON.stringify({
          ...(status === undefined ? {} : { status }),
          total: result.docs.length,
          hasMore: result.hasNextPage,
          results: result.docs.map(mediaSummary),
        }),
      );
    },
  };
}

function getMediaTool(context: ToolContext): AgentTool {
  return {
    name: "get_media",
    label: "Read a file's details",
    description:
      "Reads one file's metadata: filename, type, size, dimensions and alternative text.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    async execute(_id, parameters) {
      context.spend();
      const { id } = parameters as { id: string };
      const file = await context.cms.media.get(id);
      if (!file) throw CmsError.notFound(`No file with id "${id}".`);
      return toolText(JSON.stringify({ ...mediaSummary(file), alt: file.alt }));
    },
  };
}

function updateMediaTool(context: ToolContext): AgentTool {
  return {
    name: "update_media",
    label: "Save a file's details",
    description:
      "Changes a file's filename or alternative text. The file itself is never touched.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 200 }),
      filename: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      alt: Type.Optional(Type.String({ maxLength: 2_000 })),
      locale: Type.Optional(Type.String({ maxLength: 20 })),
    }),
    async execute(_id, parameters) {
      context.spend();
      const input = parameters as {
        id: string;
        filename?: string;
        alt?: string;
        locale?: string;
      };
      if (input.filename === undefined && input.alt === undefined) {
        throw CmsError.validation(
          "Give a filename or an alt text; there is nothing else to change here.",
        );
      }
      const locale = localeFor(context.config, context.page, input.locale);
      assertMediaFormIsClean(context, input.id);
      const updated = await context.cms.media.update({
        id: input.id,
        actor: context.actor,
        source: "ai",
        locale,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.alt === undefined ? {} : { alt: input.alt }),
      });

      const fields = [
        ...(input.filename === undefined ? [] : ["filename"]),
        ...(input.alt === undefined ? [] : ["alt"]),
      ];
      context.onMutation({ kind: "media", id: updated.id, locale }, fields);
      return toolText(JSON.stringify({ saved: true, id: updated.id, fields }));
    },
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function getActivityTool(context: ToolContext): AgentTool {
  return {
    name: "get_activity",
    label: "Read the audit trail",
    description:
      "Who changed what, most recent first. Read-only, and only for accounts that may read the trail.",
    parameters: Type.Object({
      collection: Type.Optional(Type.String({ maxLength: 120 })),
      documentId: Type.Optional(Type.String({ maxLength: 200 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxActivityResults })), // prettier-ignore
    }),
    async execute(_id, parameters) {
      context.spend();
      requirePermissionFor(context, "activity:read");
      const input = parameters as {
        collection?: string;
        documentId?: string;
        limit?: number;
      };
      const page = await context.cms.activity.list({
        limit: Math.min(input.limit ?? 10, maxActivityResults),
        ...(input.collection === undefined
          ? {}
          : {
              collection: requireCollection(context.config, input.collection)
                .name,
            }),
        ...(input.documentId === undefined
          ? {}
          : { documentId: input.documentId }),
      });

      return toolText(
        JSON.stringify(
          page.entries.map((entry) => ({
            at: entry.createdAt,
            action: entry.action,
            source: entry.source,
            actorId: entry.actorId,
            collection: entry.collection,
            documentId: entry.documentId,
            fields: (entry.changes?.fields as string[] | undefined) ?? [],
          })),
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Several changes at once, as one thing to approve.
 *
 * Exists because the alternative is worse: an agent that cannot batch will
 * apply a "retag these eight posts" request as eight independent writes, and
 * the editor will discover the mistake on the fifth one.
 */
function createPlanTool(context: ToolContext): AgentTool {
  return {
    name: "create_mutation_plan",
    label: "Propose a batch of changes",
    description: `Prepares up to ${maxPlanOperations} document updates and shows them to the editor as one card with Approve and Dismiss buttons. Use it whenever more than one record changes, and for a single change you want the editor to look at before it is saved. Nothing is written until they approve. ${callAtOnce}`,
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 300 }),
      changes: Type.Array(
        Type.Object({
          collection: Type.String({ minLength: 1, maxLength: 120 }),
          id: Type.String({ minLength: 1, maxLength: 200 }),
          locale: Type.Optional(Type.String({ maxLength: 20 })),
          data: Type.Record(Type.String(), Type.Any()),
        }),
        { minItems: 1, maxItems: maxPlanOperations },
      ),
    }),
    async execute(_id, parameters) {
      context.spend("proposal");
      const input = parameters as {
        summary: string;
        changes: {
          collection: string;
          id: string;
          expectedRevision?: number;
          locale?: string;
          data: JsonObject;
        }[];
      };

      const operations: PlanOperation[] = [];
      for (const change of input.changes) {
        const collection = requireCollection(
          context.config,
          change.collection,
          "collection",
        );
        const locale = localeFor(context.config, context.page, change.locale);
        assertFormIsClean(context, collection, change.id);
        const data = shapePatch(collection, change.data, context.actor, locale);
        // Read it now, so the label on the approval screen is the title the
        // editor knows the record by rather than an id they have to look up.
        const document = await readDocument(
          context,
          collection,
          change.id,
          locale,
        );
        operations.push({
          action: "update",
          collection: collection.name,
          id: String(document.id),
          locale,
          // What the model read if it read it; otherwise what is there now,
          // which is what the editor approves against.
          expectedRevision:
            change.expectedRevision ??
            context.revisions?.get(documentKey(collection, document.id)) ??
            Number(document.revision ?? 1),
          data,
          label: recordTitle(document, titleField(collection)),
          fields: Object.keys(data),
        });
      }

      return park(context, {
        kind: "bulk-update",
        summary: input.summary,
        operations,
      });
    },
  };
}

async function park(
  context: ToolContext,
  args: { kind: string; summary: string; operations: PlanOperation[] },
): Promise<ReturnType<typeof toolText>> {
  const plan = await context.plans.create({
    runId: context.runId,
    actor: context.actor,
    kind: args.kind,
    summary: args.summary,
    operations: args.operations,
  });
  const summary = planSummary(plan);
  context.onPlan(summary);

  // No plan id, and the records' titles rather than their ids. The model
  // cannot approve anything, so an id is of no use to it — and what it is
  // given, it repeats: answers ended "plan aip_… awaits approval, please
  // confirm", or listed a batch as six `doc_…` lines, because the ids it had
  // typed into the call were the only names it had for the records.
  const titles = plan.operations
    .filter(
      (operation) =>
        operation.id !== undefined && operation.label !== operation.id,
    )
    .map((operation) => operation.label);
  return toolText(
    JSON.stringify({
      saved: false,
      awaitingApproval: true,
      records: plan.operations.length,
      ...(titles.length === 0 ? {} : { titles }),
      note: "Nothing is written yet. Under your reply the editor sees this change as a card with Approve and Dismiss buttons, and that card is their confirmation. In a sentence or two, say what you prepared, naming records by title and never by id, and that it is waiting for their approval. Do not ask them to confirm in words, do not list the plan again, never say it was saved, and end your reply there.",
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * The collection rule, asked before a plan is written.
 *
 * The engine asks it again when the plan is executed, with the record in
 * hand, and that is the check that decides. This one exists so the editor is
 * never shown an approval dialog for something that cannot happen.
 */
async function assertMayOperate(
  context: ToolContext,
  collection: ResolvedCollection,
  operation: "create" | "update" | "delete",
): Promise<void> {
  if (context.config.rbac) {
    const permission = `${collection.name}:${operation}`;
    if (!permits(context.actor, permission)) {
      throw CmsError.forbidden(`This account does not have "${permission}".`);
    }
  }
  const rule = collection.access[operation];
  if (!rule) return;
  const result = await rule({
    actor: context.actor,
    operation,
    locale: context.page.locale,
  });
  if (result === false) {
    throw CmsError.forbidden(
      `This account may not ${operation} ${collection.name}.`,
    );
  }
}

/**
 * Refuses to write a record whose form has unsaved changes.
 *
 * Two bad outcomes at once, both of them silent: the editor's unsaved text is
 * overwritten by the agent, or the editor presses Save a minute later and
 * overwrites the agent. Asking is the only honest option, and it is cheap —
 * the panel already knows which fields are dirty.
 */
function assertMediaFormIsClean(context: ToolContext, id: string): void {
  const page = context.page;
  if (page.kind !== "media" || page.mediaId !== id) return;
  if (page.dirtyFields.length === 0) return;
  throw new CmsError(
    `The editor has unsaved changes to ${page.dirtyFields.join(", ")} in this file's details pane. Ask them to save or discard those changes first.`,
    { status: 409, code: "active_draft_dirty" },
  );
}

/**
 * One record per request is saved directly; a second is a plan.
 *
 * "Anything touching more than one record goes through an approval" was a
 * sentence in the prompt and nothing else, and a small model asked to fill in
 * a field on every post saved them one by one — then ran out of steps and
 * asked the editor whether it should do the rest, which is the double
 * confirmation the approval card exists to replace. Refusing the second
 * record here sends the model to `create_mutation_plan` with the remaining
 * changes, in the same run, and makes the rule the documentation states a
 * rule rather than a hope. The same record again is fine: a second field, or
 * a retry after a conflict, is still one record.
 */
function assertOneRecord(context: ToolContext, key: string): void {
  const saved = context.savedDocuments;
  if (!saved || saved.size === 0 || saved.has(key)) return;
  throw new CmsError(
    "This request has already saved a change to another record, and changes to more than one record need the editor's approval. Nothing was written. Put this change, and any others still to make, into one create_mutation_plan now. Do not ask the editor first: the card is how they approve.",
    { status: 409, code: "ai_plan_required" },
  );
}

function assertFormIsClean(
  context: ToolContext,
  collection: ResolvedCollection,
  id: string | null,
): void {
  const page = context.page;
  if (page.dirtyFields.length === 0) return;
  if (page.collection?.name !== collection.name) return;
  if (id !== null && page.documentId !== id) return;

  throw new CmsError(
    `The editor has unsaved changes to ${page.dirtyFields.join(", ")} in this form. Ask them to save or discard those changes first; writing now would overwrite one of you.`,
    { status: 409, code: "active_draft_dirty" },
  );
}

/**
 * A patch, checked field by field before anything reaches the engine.
 *
 * The engine would refuse an unknown field and a forbidden one anyway. Doing
 * it here as well is not belt and braces: the message the agent reads matters,
 * and "`seoTitle` is not a field of posts — call describe_cms" is a message it
 * can act on, where a generic validation failure is one it will retry
 * verbatim.
 */
function shapePatch(
  collection: ResolvedCollection,
  data: JsonObject,
  actor: Actor | null,
  locale: string,
): JsonObject {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    throw CmsError.validation("`data` has to name at least one field.");
  }

  const result: JsonObject = {};
  for (const [name, value] of entries) {
    if (!(name in collection.fields)) {
      throw CmsError.validation(
        `"${name}" is not a field of ${collection.name}. Call describe_cms and use a field that exists.`,
      );
    }
    if (!mayReadField(collection, name, actor, locale)) {
      // Same message as a field that does not exist. A "you may not write it"
      // on a field whose name was a guess confirms the guess.
      throw CmsError.validation(
        `"${name}" is not a field of ${collection.name}. Call describe_cms and use a field that exists.`,
      );
    }
    if (!mayWriteField(collection, name, actor, locale)) {
      throw CmsError.forbidden(
        `This account may not write ${collection.name}.${name}.`,
      );
    }
    result[name] = shapeFieldValue(collection, name, value as JsonValue);
  }
  return result;
}

function documentKey(
  collection: ResolvedCollection,
  id: JsonValue | undefined,
): string {
  // prettier-ignore
  return `document:${collection.name}:${String(id)}`;
}

function globalKey(global: ResolvedCollection): string {
  return `global:${global.name}`;
}

function remember(
  context: ToolContext,
  key: string,
  revision: JsonValue | undefined,
): void {
  // prettier-ignore
  const value = Number(revision);
  if (Number.isInteger(value) && value > 0) context.revisions?.set(key, value);
}

/**
 * The revision a write is made against: the one a caller passed, or the one
 * this run read. A record the run never read is refused rather than written
 * blind — the rule the prompt asks for, enforced where it cannot be argued
 * with.
 */
function revisionFor(
  context: ToolContext,
  key: string,
  given: number | undefined,
): number {
  // prettier-ignore
  if (given !== undefined) return given;
  const known = context.revisions?.get(key);
  if (known !== undefined) return known;
  throw CmsError.validation(
    "Read this record first (get_document, or get_current_page for the one on screen); a change is only ever made to a version you have read.",
  );
}

function readableFields(
  collection: ResolvedCollection,
  actor: Actor | null,
  locale: string,
): string[] {
  return Object.keys(collection.fields).filter((name) =>
    mayReadField(collection, name, actor, locale),
  );
}

/**
 * `forDisplay` resolves relations one level deep, through the engine and
 * with the same actor — a related record this account cannot read stays an
 * id — so that the record can name what it points at.
 */
interface ReadOptions {
  forDisplay?: boolean;
}

async function readDocument(
  context: ToolContext,
  collection: ResolvedCollection,
  id: string,
  locale: string,
  options: ReadOptions = {},
): Promise<JsonObject> {
  const document = await collectionApi(context, collection).findById(id, {
    actor: context.actor,
    locale,
    includeTrashed: true,
    ...(options.forDisplay ? { depth: 1 } : {}),
  });
  if (!document) {
    throw CmsError.notFound(
      `No ${collection.name} with id "${id}", or this account cannot read it.`,
    );
  }
  return document;
}

async function readGlobal(
  context: ToolContext,
  global: ResolvedCollection,
  locale: string,
  options: ReadOptions = {},
): Promise<JsonObject> {
  return globalApi(context, global).get({
    actor: context.actor,
    locale,
    ...(options.forDisplay ? { depth: 1 } : {}),
  });
}

/**
 * The name a related record goes by: its collection's title field, a file's
 * name, a user's display name. Anything else stays an id — a relation into
 * a table this file knows nothing about is not one to start reading from.
 */
function relationTitle(context: ToolContext): RelationTitle {
  return (target, document) => {
    const collection = context.config.collections[target];
    if (collection) return recordTitle(document, titleField(collection));
    const key =
      target === "media" ? "filename" : target === "cms_users" ? "name" : null;
    const value = key === null ? undefined : document[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  };
}

export function collectionApi(
  context: { cms: CmsInstance },
  collection: ResolvedCollection,
): CollectionApi<JsonObject> {
  const api = (
    context.cms.api as unknown as Record<string, CollectionApi<JsonObject>>
  )[collection.name];
  if (!api) {
    throw CmsError.notFound(`No collection named "${collection.name}".`);
  }
  return api;
}

export function globalApi(
  context: { cms: CmsInstance },
  global: ResolvedCollection,
): GlobalApi<JsonObject> {
  const api = (
    context.cms.globals as unknown as Record<string, GlobalApi<JsonObject>>
  )[global.name];
  if (!api) throw CmsError.notFound(`No global named "${global.name}".`);
  return api;
}

/**
 * A text search over the fields that hold text.
 *
 * Deliberately not an arbitrary filter expression. The model never gets to
 * compose a `where` clause: a query language is a surface, and a surface the
 * model controls is one somebody will eventually get it to point somewhere
 * unintended.
 */
interface Search {
  where: ReturnType<typeof and>;
  /** The phrase first, then its words; the phrase weighs more. */
  patterns: string[];
  fields: string[];
}

function where(
  collection: ResolvedCollection,
  query: string | undefined,
  actor: Actor | null,
  locale: string,
): Search | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;

  // The phrase, and each distinctive word of it on its own. Models search
  // with a sentence ("failed card payments") and a title says it another way
  // ("What happens when a payment fails?"); matching the phrase alone sent
  // the agent round six searches for an article that was there all along.
  const words = [
    ...new Set(
      trimmed
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4)
        // A crude stem, and deliberately so: the first five letters are what
        // "payments" shares with "payment" and "płatnościach" with
        // "płatność". Over-matching is cheap — the ranking below sorts it out —
        // and missing the record is what costs another round trip.
        .map((word) => (word.length >= 6 ? word.slice(0, 5) : word)),
    ),
  ].slice(0, 6);
  const patterns = [trimmed, ...words.filter((word) => word !== trimmed.toLowerCase())]; // prettier-ignore

  const fields = Object.entries(collection.fields).filter(
    ([name, field]) =>
      ["text", "textarea", "email", "slug"].includes(field.type) &&
      mayReadField(collection, name, actor, locale),
  );
  const searchable = fields.flatMap(([name, field]) =>
    patterns.map((pattern) =>
      like(field.localized ? `${name}.${locale}` : name, `%${pattern}%`, true),
    ),
  );

  if (searchable.length === 0) return undefined;
  return {
    where: and(or(...searchable, eq("id", trimmed))),
    patterns,
    fields: fields.map(([name]) => name),
  };
}

/**
 * The candidates, best first: the whole phrase beats a word, the title beats
 * any other field, and ties keep the database's order (newest first).
 */
function rank(
  docs: JsonObject[],
  patterns: string[],
  fields: string[],
  title: string | null,
): JsonObject[] {
  const lowered = patterns.map((pattern) => pattern.toLowerCase());
  const score = (document: JsonObject): number => {
    let total = 0;
    for (const name of fields) {
      const value = document[name];
      if (typeof value !== "string") continue;
      const text = value.toLowerCase();
      const weight = name === title ? 2 : 1;
      lowered.forEach((pattern, index) => {
        if (text.includes(pattern)) total += weight * (index === 0 ? 3 : 1);
      });
    }
    return total;
  };
  return docs
    .map((document, index) => ({ document, index, score: score(document) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.document);
}

function mediaSummary(file: MediaDocument): JsonObject {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
    width: file.width,
    height: file.height,
  };
}

/**
 * A permission a tool needs over and above the engine's own checks.
 *
 * Only for the resources that have no collection to carry an `access` rule —
 * the audit trail is the first of them. Without `rbac` configured there is
 * nothing to check, which matches every other administrative endpoint.
 */
function requirePermissionFor(context: ToolContext, permission: string): void {
  if (!context.config.rbac) return;
  if (permits(context.actor, permission)) return;
  throw CmsError.forbidden(`This account does not have "${permission}".`);
}

function localeCodes(cms: CmsInstance): string[] {
  return cms.locales.list().map((locale) => locale.code);
}
