import type { ActivityPage } from "@heyo-sh/heyo-cms/types";
import { Badge, Card, Empty, Spinner, Stat, Text, cn } from "@heyo-sh/heyo-ui";
import {
  IconActivity,
  IconArrowRight,
  IconFileText,
  IconLanguage,
  IconPhoto,
  IconWorld,
} from "@tabler/icons-react";

import { api } from "../lib/api";
import { formatRelative } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { Link } from "../lib/router";
import { Page, PageBar, PageBody } from "../components/page";

/**
 * The landing screen: what there is, and what happened.
 *
 * No charts. The two questions somebody opening a CMS actually has are "where
 * is the thing I was editing" and "did my colleague change it", and the audit
 * trail answers the second one exactly, because the engine writes it inside
 * the transaction that caused each line.
 *
 * The trail is requested optimistically and its failure is not shown:
 * `activity:read` is a permission, and an editor without it should see a
 * dashboard, not an error.
 */
export function Dashboard() {
  const { config, session } = usePanel();

  const activity = useAsync(
    (signal) =>
      api
        .get<ActivityPage>("/activity", { signal, query: { limit: 10 } })
        .catch(() => null),
    [],
  );

  const who = session.user?.name?.trim();
  const greeting = who ? `Hello, ${who}` : "Hello";

  return (
    <Page>
      <PageBar crumbs={[{ label: "Home" }]} usage={{ kind: "dashboard" }} />

      <PageBody flush className="overflow-auto heyo-scrollbar">
        <DashboardGreeting greeting={greeting} />

        <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
          <Stat.Group columns={4}>
            <Stat
              icon={IconFileText}
              label="Collections"
              value={config.collections.length}
            />
            <Stat
              icon={IconWorld}
              label="Globals"
              value={config.globals.length}
            />
            <Stat
              icon={IconLanguage}
              label="Languages"
              value={config.i18n.locales.length}
            />
            <Stat
              icon={IconPhoto}
              label="Media"
              value={config.media.enabled ? "On" : "Off"}
            />
          </Stat.Group>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Text size="xs" weight="medium" tone="subtle" as="h2">
                Content
              </Text>
              <Text size="xs" tone="inactive">
                Choose a destination to start editing
              </Text>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {config.collections.map((collection) => (
                <Tile
                  key={collection.slug}
                  to={`/c/${collection.slug}`}
                  icon={IconFileText}
                  title={collection.label}
                  badge={
                    collection.can.create ? null : (
                      <Badge
                        variant="outline"
                        size="sm"
                        title="Your account may not create documents here"
                      >
                        read-only
                      </Badge>
                    )
                  }
                  description={
                    collection.description ??
                    count(collection.fields.length, "field")
                  }
                />
              ))}

              {config.globals.map((global) => (
                <Tile
                  key={global.slug}
                  to={`/g/${global.slug}`}
                  icon={IconWorld}
                  title={global.label}
                  description={`Singleton · ${count(global.fields.length, "field")}`}
                />
              ))}

              {config.media.enabled ? (
                <Tile
                  to="/media"
                  icon={IconPhoto}
                  title="Media"
                  description={
                    config.media.purgeAfter
                      ? `Unused files are removed after ${config.media.purgeAfter}`
                      : "Every upload, with what points at it"
                  }
                />
              ) : null}
            </div>
          </section>

          <section className="min-w-0">
            <Card className="overflow-hidden gap-0 p-0">
              <div className="flex h-11 items-center gap-2 border-b border-heyo-hairline px-3">
                <IconActivity className="size-4 text-heyo-subtle" />
                <Text size="sm" weight="medium" tone="strong" as="h2">
                  Recent activity
                </Text>
                <Link
                  to="/settings?tab=activity"
                  className="ml-auto text-xs text-heyo-subtle underline-offset-2 hover:text-heyo-default hover:underline heyo-focus"
                >
                  View all
                </Link>
              </div>
              {activity.loading ? (
                <div className="flex justify-center p-6">
                  <Spinner size="sm" />
                </div>
              ) : activity.data && activity.data.entries.length > 0 ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {activity.data.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 px-3 py-2.5 not-last:border-b not-last:border-heyo-hairline"
                    >
                      <IconActivity className="size-3.5 shrink-0 text-heyo-inactive" />
                      <div className="min-w-0 flex-1">
                        <Text size="sm" as="span" className="truncate">
                          {phrase(entry.action)}
                        </Text>
                        {entry.collection ? (
                          <Text size="xs" tone="subtle" truncate>
                            {entry.collection}
                          </Text>
                        ) : null}
                      </div>
                      <Text
                        size="xs"
                        tone="subtle"
                        as="span"
                        className="shrink-0 whitespace-nowrap"
                      >
                        {formatRelative(entry.createdAt)}
                      </Text>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  icon={IconActivity}
                  className="m-4"
                  title="Nothing yet"
                  description="Every write the engine makes is recorded here, inside the transaction that caused it."
                />
              )}
            </Card>
          </section>
        </div>
      </PageBody>
    </Page>
  );
}

/**
 * The greeting strip.
 *
 * Half the height it was, and no photograph: the artwork is six absolutely
 * positioned spans and a stylesheet (`.heyo-banner*` in `styles.css`, where
 * the motion is explained), so the home screen paints in full on the first
 * frame instead of waiting on a request to another origin for a third of the
 * fold. The layers are inert and `aria-hidden`: a screen reader gets the
 * greeting, which is the only content in here.
 *
 * The heading's padding matches the content below it — `p-4 md:p-6` — so the
 * name of the person and the first card share one left edge.
 */
function DashboardGreeting({ greeting }: { greeting: string }) {
  return (
    <section className="heyo-banner h-26 shrink-0 overflow-hidden border-b border-heyo-hairline">
      <div aria-hidden="true" className="heyo-banner-art">
        <span className="heyo-banner-grid" />
        <span className="heyo-banner-wash heyo-banner-wash-a" />
        <span className="heyo-banner-wash heyo-banner-wash-b" />
        <span className="heyo-banner-wash heyo-banner-wash-c" />
        <span className="heyo-banner-beam heyo-banner-beam-a" />
        <span className="heyo-banner-beam heyo-banner-beam-b" />
        <span className="heyo-banner-beam heyo-banner-beam-c" />
        <span className="heyo-banner-sweep" />
        <span className="heyo-banner-veil" />
      </div>
      <div className="relative flex h-full items-center px-4 md:px-6">
        {/* Regular weight, not semibold. Nothing else in the panel is set
            heavier than `medium`, and a bold line at three times the size of
            every other word on the screen shouts a greeting that is not news
            — the size alone already says this is the top of the page. Ink
            colour and scale carry it; the weight does not have to.

            `min-w-0`, or the flex item refuses to shrink below the width of
            a name that does not wrap and the ellipsis never arrives. */}
        <h1 className="min-w-0 truncate text-2xl font-normal tracking-tight text-heyo-strong sm:text-3xl">
          {greeting}
        </h1>
      </div>
    </section>
  );
}

function Tile({
  to,
  icon: Icon,
  title,
  description,
  badge,
}: {
  to: string;
  icon: typeof IconFileText;
  title: string;
  description: string;
  badge?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group/tile flex h-full min-w-0 flex-col gap-2 rounded-xl p-4",
        "bg-heyo-base text-inherit ring-1 ring-heyo-hairline",
        "transition-colors duration-100 ease-heyo hover:bg-heyo-tint heyo-focus",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-heyo-fill text-heyo-subtle">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Text size="sm" weight="medium" tone="strong" as="span" truncate>
            {title}
          </Text>
          <Text size="xs" tone="subtle" truncate>
            {description}
          </Text>
        </div>
        {badge}
        <IconArrowRight className="size-3.5 shrink-0 text-heyo-inactive transition-colors group-hover/tile:text-heyo-subtle" />
      </div>
    </Link>
  );
}

/** `document.created` → "document created", which is what happened. */
function phrase(action: string): string {
  return action.replaceAll(".", " ").replaceAll("_", " ");
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
