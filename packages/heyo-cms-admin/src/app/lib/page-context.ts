import type { AiPageContext, PanelConfig } from "@heyo-sh/heyo-cms/types";

/**
 * Where the editor is, from the URL alone.
 *
 * One function, used twice and for two different reasons. `App` registers it
 * as the baseline for the screens that have nothing to add to it — a list,
 * the trash, settings — and the assistant provider uses it as the floor under
 * whatever a screen registered, so a send that happens before a screen's
 * effect has run, or on a path no screen owns, still says where it came from
 * and in which language. The alternative was a request with no context at
 * all, which the server reads as "the dashboard, in the default locale": the
 * one answer that is wrong on every screen.
 *
 * It is deliberately conservative. A path whose collection does not exist
 * renders the panel's own "nothing here", so it resolves to `dashboard`
 * rather than to a list of a collection nobody has: a context that names a
 * screen the editor cannot see would have the assistant explain a record it
 * invented. `kind` is the closed set the engine knows, and `dashboard` is
 * that set's word for "there is nothing here to act on".
 */
export function routePageContext(
  path: string,
  config: PanelConfig,
): AiPageContext {
  const [, section, slug, rest] = path.split("/");

  if (section === "c") {
    const collection = config.collections.find((entry) => entry.slug === slug);
    if (!collection || slug === undefined) return { kind: "dashboard" };
    if (!rest) return { kind: "collection-list", collectionSlug: slug };
    return {
      kind: "document",
      collectionSlug: slug,
      // `new` is the panel's word for an unsaved form, not an id. Sending it
      // would have the agent look for a document called "new".
      ...(rest === "new" ? {} : { documentId: rest }),
    };
  }

  if (section === "g") {
    const global = config.globals.find((entry) => entry.slug === slug);
    return global && slug !== undefined
      ? { kind: "global", collectionSlug: slug }
      : { kind: "dashboard" };
  }

  if (section === "media" && config.media.enabled) return { kind: "media" };
  if (section === "trash" && config.trash.enabled) return { kind: "trash" };
  if (section === "settings") return { kind: "settings" };

  return { kind: "dashboard" };
}

/**
 * Whether the screen at this path registers its own, richer context.
 *
 * The three editors do: they know the revision the form was loaded from, the
 * fields that are unsaved and the file the details pane is showing, none of
 * which is in the URL. `App` leaves those alone rather than racing them —
 * a child's effect fires before its parent's, so a baseline set above them
 * would land last and overwrite the richer one.
 */
export function screenOwnsPageContext(context: AiPageContext): boolean {
  return (
    context.kind === "document" ||
    context.kind === "global" ||
    context.kind === "media"
  );
}
