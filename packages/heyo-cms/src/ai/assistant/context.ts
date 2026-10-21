import { CmsError } from "../../errors";
import type { AiPageContext, AiPageContextKind } from "../../types/ai";
import type { ResolvedCmsConfig, ResolvedCollection } from "../../types/config";
import type { JsonObject } from "../../types/json";

const kinds = new Set<AiPageContextKind>([
  "dashboard",
  "collection-list",
  "document",
  "global",
  "media",
  "trash",
  "settings",
]);

const maxDirtyFields = 100;
const maxIdChars = 200;
const maxTabChars = 120;
const settingsTabs = new Set([
  "users",
  "roles",
  "locales",
  "keys",
  "ai",
  "webhooks",
  "deployment",
  "activity",
]);

/**
 * The page context, taken from the browser and immediately distrusted.
 *
 * Everything in it is a *hint about where the editor is looking*, never a
 * grant. The slug is re-resolved against the configuration, the locale
 * against the registry, and the document is re-read through `cms.api` with
 * the actor from the session. This cannot grant access to protected records;
 * it can still point the model at a different record the caller *can* reach,
 * so a page hint is never evidence of the user's intent to write to it.
 *
 * Parsed defensively rather than validated strictly: a panel version that
 * sends a field this one does not know about should lose that field, not the
 * conversation.
 */
export function parsePageContext(value: unknown): AiPageContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as JsonObject;
  const kind = raw.kind;
  if (typeof kind !== "string" || !kinds.has(kind as AiPageContextKind)) {
    return undefined;
  }

  const dirty = Array.isArray(raw.dirtyFields)
    ? raw.dirtyFields
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, maxDirtyFields)
    : undefined;
  const revision = Number(raw.baselineRevision);

  return {
    kind: kind as AiPageContextKind,
    ...(typeof raw.collectionSlug === "string"
      ? { collectionSlug: raw.collectionSlug.slice(0, maxIdChars) }
      : {}),
    ...(typeof raw.documentId === "string"
      ? { documentId: raw.documentId.slice(0, maxIdChars) }
      : {}),
    ...(typeof raw.mediaId === "string"
      ? { mediaId: raw.mediaId.slice(0, maxIdChars) }
      : {}),
    // Trimmed as well as capped: a tab name is repeated to the model, and a
    // thousand spaces is not a tab name.
    ...(typeof raw.tab === "string" && raw.tab.trim().length > 0
      ? { tab: raw.tab.trim().slice(0, maxTabChars) }
      : {}),
    ...(typeof raw.locale === "string" ? { locale: raw.locale } : {}),
    ...(dirty && dirty.length > 0 ? { dirtyFields: dirty } : {}),
    ...(Number.isInteger(revision) && revision > 0
      ? { baselineRevision: revision }
      : {}),
  };
}

export interface ResolvedPageContext {
  kind: AiPageContextKind;
  collection: ResolvedCollection | null;
  documentId: string | null;
  /** The file the details pane is showing, on the media screen only. */
  mediaId: string | null;
  /** The sub-surface in front: a rich-text tab, a settings tab, a status. */
  tab: string | null;
  locale: string;
  dirtyFields: string[];
  baselineRevision: number | null;
}

/**
 * The context with its names turned into configuration objects.
 *
 * A slug that names nothing resolves to `null` rather than throwing: the
 * editor may be on a screen this server version does not have, and refusing
 * the whole conversation over it would be a worse answer than "I cannot see
 * what you are looking at, which record did you mean".
 *
 * `fallbackLocale` is the language the caller named outside the context
 * (`runAssistant({ locale })`). It sits between the context and the project
 * default, because a screen that has no record — a list, the media library —
 * still has a language, and defaulting to the project's would make the agent
 * search the English column for an editor who is working in Polish.
 */
export function resolvePageContext(
  config: ResolvedCmsConfig,
  context: AiPageContext | undefined,
  fallbackLocale?: string | undefined,
): ResolvedPageContext {
  const fallback =
    fallbackLocale !== undefined && knownLocale(config, fallbackLocale)
      ? fallbackLocale
      : config.i18n.defaultLocale;
  if (!context) {
    return {
      kind: "dashboard",
      collection: null,
      documentId: null,
      mediaId: null,
      tab: null,
      locale: fallback,
      dirtyFields: [],
      baselineRevision: null,
    };
  }

  const locale =
    context.locale !== undefined && knownLocale(config, context.locale)
      ? context.locale
      : fallback;
  const collection = pageCollection(config, context);

  return {
    kind: context.kind,
    collection,
    documentId: context.documentId ?? null,
    mediaId: context.kind === "media" ? (context.mediaId ?? null) : null,
    tab: pageTab(context, collection),
    locale,
    dirtyFields: context.dirtyFields ?? [],
    baselineRevision: context.baselineRevision ?? null,
  };
}

/**
 * Only a tab that exists on this screen reaches the system prompt.
 *
 * Settings reads its tab from a query string, which may be an arbitrary URL
 * supplied by someone else. Quoting arbitrary text from that URL in a
 * high-priority prompt would be a prompt-injection route. A capped string is
 * still an instruction; the panel's real tabs are a small, closed set (or a
 * configured rich-text field name), and unknown ones are just ignored.
 */
function pageTab(
  context: AiPageContext,
  collection: ResolvedCollection | null,
): string | null {
  const tab = context.tab;
  if (!tab) return null;
  if (context.kind === "settings") return settingsTabs.has(tab) ? tab : null;
  if (context.kind === "media") {
    return tab === "active" || tab === "orphaned" ? tab : null;
  }
  if (context.kind === "document" || context.kind === "global") {
    return collection?.fields[tab]?.type === "richText" ? tab : null;
  }
  return null;
}

/**
 * The collection the screen is about, or nothing.
 *
 * Two things make this stricter than `requireCollection`. The panel always
 * sends a *slug*, because a slug is what is in the URL it is reading — so a
 * slug match wins over a name match, or a deployment where one collection is
 * named `articles` and another is *slugged* `articles` would have the
 * assistant reading the wrong one and reporting it confidently.
 *
 * And the kind has to agree with the screen. A document screen naming a
 * global is not a document screen: taking it at its word would send
 * `get_current_page` down the document path with a singleton's name, where
 * the failure is an opaque "no collection named site_settings" rather than
 * "I cannot see what you are looking at".
 */
function pageCollection(
  config: ResolvedCmsConfig,
  context: AiPageContext,
): ResolvedCollection | null {
  if (context.collectionSlug === undefined) return null;
  const wanted =
    context.kind === "global"
      ? "global"
      : context.kind === "document" || context.kind === "collection-list"
        ? "collection"
        : undefined;
  // Every other screen — the dashboard, media, trash, settings — is not about
  // one collection, so a slug on it is noise rather than a pointer.
  if (wanted === undefined) return null;

  // Page contexts come from the URL, never from a model-produced name. A
  // fallback to `all[slug]` could silently point at a different collection
  // after the collection in the URL is removed or renamed.
  const all = { ...config.collections, ...config.globals };
  const found = Object.values(all).find(
    (collection) => collection.slug === context.collectionSlug,
  );
  if (!found || found.kind !== wanted) return null;
  return found;
}

/**
 * A collection by whichever name the model used.
 *
 * The schema gives it both `name` and `slug` and models are not reliable about
 * which one they echo back. Accept either unless the same string names two
 * different collections. In that case guessing a precedence would turn a
 * legitimate request into a write to the wrong collection. Make the agent
 * disambiguate by using an unambiguous name or slug instead.
 */
export function requireCollection(
  config: ResolvedCmsConfig,
  name: string,
  kind?: "collection" | "global",
): ResolvedCollection {
  const all = { ...config.collections, ...config.globals };
  const byName = all[name];
  const bySlug = Object.values(all).find((entry) => entry.slug === name);
  if (byName && bySlug && byName.name !== bySlug.name) {
    throw CmsError.validation(
      `"${name}" is ambiguous: it names ${byName.name} and is the slug of ${bySlug.name}. Use an unambiguous name or slug from describe_cms.`,
    );
  }
  const found = byName ?? bySlug;
  if (!found) {
    throw CmsError.notFound(
      `There is no collection called "${name}". Call describe_cms for the list.`,
    );
  }
  if (kind && found.kind !== kind) {
    throw CmsError.validation(`"${name}" is a ${found.kind}, not a ${kind}.`);
  }
  return found;
}

function knownLocale(config: ResolvedCmsConfig, locale: string): boolean {
  return config.i18n.locales.includes(locale);
}

/**
 * The locale a tool call should use.
 *
 * The model may name one; otherwise the page the editor is on decides, and
 * only then the project default. Guessing the default when the editor is
 * clearly editing German would write the English column, which is the kind of
 * mistake that is invisible until somebody opens the other language.
 */
export function localeFor(
  config: ResolvedCmsConfig,
  page: ResolvedPageContext,
  requested?: string | undefined,
): string {
  if (requested !== undefined && knownLocale(config, requested)) {
    return requested;
  }
  if (requested !== undefined) {
    throw CmsError.validation(
      `"${requested}" is not a configured locale. Call describe_cms for the list.`,
    );
  }
  return page.locale;
}
