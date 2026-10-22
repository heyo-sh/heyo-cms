import type { TrashPage } from "@heyo-sh/heyo-cms/types";
import { Badge, Button, Card, Empty, Table, Text } from "@heyo-sh/heyo-ui";
import { IconRotateClockwise, IconTrash } from "@tabler/icons-react";
import { api } from "../lib/api";
import { documentTitle, formatCountdown, formatRelative } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { useRouter } from "../lib/router";
import { toast } from "../lib/toast";
import { ErrorNote } from "../components/chrome";
import { useConfirm } from "../components/confirm";
import { Page, PageBar, PageBody, PageLoader } from "../components/page";
import { openable, stopRowClick } from "../components/row";

/**
 * The bin, across every collection at once.
 *
 * One list rather than a tab per collection, because that is what the engine
 * offers (`GET /trash`) and because "what did I delete this morning" is not a
 * per-collection question. The countdown comes from `purgeAfter` on each
 * entry — the deadline the server set when the document was deleted, not a
 * duration the panel recomputed — so what is shown is what will happen.
 *
 * A collection the caller may not read contributes nothing, which makes the
 * list shorter rather than forbidden.
 */
export function Trash() {
  const { config, locale } = usePanel();
  const { navigate } = useRouter();
  const confirm = useConfirm();

  const page = useAsync<TrashPage>(
    (signal) =>
      api.get<TrashPage>("/trash", {
        signal,
        query: { limit: 50, locale },
      }),
    [locale],
  );

  const restore = async (slug: string, id: string) => {
    try {
      await api.post(`/trash/${slug}/${id}/restore`);
      toast.success("Restored.");
      await page.reload();
    } catch (error) {
      toast.error(error);
    }
  };

  const purge = async (slug: string, id: string, title: string) => {
    await confirm({
      title: "Remove this document for good?",
      description:
        "Purging skips the retention period and deletes the row now. Nothing restores it afterwards.",
      consequences: [title],
      confirmLabel: "Purge",
      destructive: true,
      run: async () => {
        await api.delete(`/trash/${slug}/${id}`);
        toast.success("Purged.");
        await page.reload();
      },
    });
  };

  const entries = page.data?.entries ?? [];
  // The deadline is the only thing about this screen that the rows do not
  // already say, so it is a tooltip on the trail rather than a paragraph.
  const crumbs = [
    {
      label: "Trash",
      hint: config.trash.purgeAfter
        ? `Restoring puts a document back where it was. Anything still here ${config.trash.purgeAfter} after deletion is removed by the purge sweep.`
        : "Restoring puts a document back where it was. Nothing is removed for good until somebody purges it.",
    },
  ];

  if (page.loading && !page.data) {
    return (
      <Page>
        <PageBar crumbs={crumbs} locale={false} usage={{ kind: "trash" }} />
        <PageLoader />
      </Page>
    );
  }

  return (
    <Page>
      <PageBar crumbs={crumbs} locale={false} usage={{ kind: "trash" }} />

      <PageBody>
        <ErrorNote error={page.error} />

        <Card className="overflow-hidden">
          <Table>
            <Table.Head>
              <Table.Row>
                <Table.Header>DOCUMENT</Table.Header>
                <Table.Header>COLLECTION</Table.Header>
                <Table.Header>DELETED</Table.Header>
                <Table.Header>REMOVED</Table.Header>
                <Table.Header align="end">ACTIONS</Table.Header>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {entries.length === 0 ? (
                <Table.Row placeholder>
                  <Table.Cell colSpan={5} className="h-auto p-6">
                    <Empty
                      icon={IconTrash}
                      title="The trash is empty"
                      description="Deleting a document puts it here first; restoring it puts it back where it was."
                      hint={
                        config.trash.purgeAfter
                          ? `Anything deleted is removed for good ${config.trash.purgeAfter} later.`
                          : "Nothing is removed for good until somebody purges it."
                      }
                    />
                  </Table.Cell>
                </Table.Row>
              ) : (
                entries.map((entry) => {
                  const definition = config.collections.find(
                    (item) => item.name === entry.collection,
                  );
                  const slug = definition?.slug ?? entry.collection;
                  const title = definition
                    ? documentTitle(definition, entry.document)
                    : entry.id;
                  return (
                    <Table.Row
                      key={`${entry.collection}:${entry.id}`}
                      aria-label={`Open ${title}`}
                      // A trashed document still opens: the editor loads it
                      // with `includeTrashed`, says so in red, and offers the
                      // same Restore button this row has.
                      {...openable(() => navigate(`/c/${slug}/${entry.id}`))}
                    >
                      <Table.Cell primary>{title}</Table.Cell>
                      <Table.Cell>
                        <Text size="sm" tone="subtle" as="span">
                          {definition?.label ?? entry.collection}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="sm" tone="subtle" as="span">
                          {formatRelative(entry.deletedAt)}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge
                          variant={entry.purgeAfter ? "warning" : "neutral"}
                          size="sm"
                        >
                          {formatCountdown(entry.purgeAfter)}
                        </Badge>
                      </Table.Cell>
                      {/*
                       * A plain cell rather than `Table.ActionCell`: that one
                       * keeps its buttons hidden until the row is hovered,
                       * which is right for a secondary action on a dense list
                       * and wrong here — restoring is the entire reason this
                       * screen exists, and a touch screen never hovers.
                       */}
                      <Table.Cell align="end" {...stopRowClick}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            icon={IconRotateClockwise}
                            onClick={() => void restore(slug, entry.id)}
                          >
                            Restore
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={IconTrash}
                            onClick={() => void purge(slug, entry.id, title)}
                          >
                            Purge
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })
              )}
            </Table.Body>
          </Table>
        </Card>
      </PageBody>
    </Page>
  );
}
