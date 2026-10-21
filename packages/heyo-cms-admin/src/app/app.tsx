import { Button, Empty } from "@heyo-sh/heyo-ui";
import { IconCompass } from "@tabler/icons-react";
import { useEffect, useMemo } from "react";

import { Shell } from "./components/shell";
import { useAssistant } from "./lib/assistant";
import { routePageContext, screenOwnsPageContext } from "./lib/page-context";
import { usePanel } from "./lib/panel";
import { Link, useRouter } from "./lib/router";
import { CollectionList } from "./screens/collection-list";
import { Dashboard } from "./screens/dashboard";
import { DocumentEdit } from "./screens/document-edit";
import { GlobalEdit } from "./screens/global-edit";
import { MediaLibrary } from "./screens/media-library";
import { Settings } from "./screens/settings";
import { Trash } from "./screens/trash";

/**
 * Which screen, from the path.
 *
 * A switch rather than a route table: there are eight screens, the matching
 * is two segments deep, and a table would be indirection over something you
 * can read in one pass. Unknown paths answer in the panel rather than in the
 * browser — the handler already served the shell for them (the SPA fallback),
 * so a 404 here is about the panel's own routes, not about the mount.
 */
export function App() {
  const { path } = useRouter();
  const { config } = usePanel();
  const [, section, slug, rest] = path.split("/");

  // The baseline context for every screen, derived from the route alone.
  // `DocumentEdit`, `GlobalEdit` and `MediaLibrary` replace it with a richer
  // one that also carries the revision, the names of unsaved fields and the
  // file in the details pane; this is what the other four screens say, and it
  // is the difference between the assistant knowing "you are looking at the
  // Posts list" and knowing nothing.
  const { setPageContext } = useAssistant();
  const route = useMemo(() => routePageContext(path, config), [path, config]);
  const registered = screenOwnsPageContext(route) ? null : route;
  // Serialized, so the effect re-registers when the *route* changes rather
  // than on every render of the panel — and so a path whose context is
  // identical still re-registers after the provider cleared it on the
  // navigation (`/c/posts` and `/c/posts/` are the same screen).
  const key = `${path}|${JSON.stringify(registered)}`;
  useEffect(() => {
    if (!registered) return;
    setPageContext(registered);
    // `registered` is derived from `key`; depending on the object identity
    // would re-register on every render of the panel instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setPageContext]);

  return <Shell>{screen()}</Shell>;

  function screen() {
    if (!section) return <Dashboard />;

    if (section === "c") {
      const collection = config.collections.find(
        (entry) => entry.slug === slug,
      );
      if (!collection) return <NotFound what={`collection "${slug}"`} />;
      if (!rest) return <CollectionList collection={collection} />;
      return (
        <DocumentEdit
          collection={collection}
          id={rest === "new" ? null : rest}
        />
      );
    }

    if (section === "g") {
      const global = config.globals.find((entry) => entry.slug === slug);
      if (!global) return <NotFound what={`global "${slug}"`} />;
      return <GlobalEdit global={global} />;
    }

    if (section === "media" && config.media.enabled) return <MediaLibrary />;
    if (section === "trash" && config.trash.enabled) return <Trash />;
    if (section === "settings") return <Settings />;

    return <NotFound what={path} />;
  }
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4 md:p-6">
      <Empty
        icon={IconCompass}
        title="Nothing here"
        description={`The panel has no screen for ${what}. It may have been renamed in the configuration.`}
        action={
          <Button
            variant="primary"
            nativeButton={false}
            render={<Link to="/" />}
          >
            Back to the dashboard
          </Button>
        }
        hint="The sidebar is generated from the configuration, so it only lists what exists."
      />
    </div>
  );
}
