import type { PanelCollection, PanelField } from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Table,
  Text,
  Tooltip,
  useSelection,
} from "@heyo-sh/heyo-ui";
import {
  IconFileText,
  IconFilterOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { api } from "../lib/api";
import { cellText, documentTitle, formatRelative } from "../lib/format";
import {
  buildCollectionFilterFieldGroups,
  createCollectionFilterFieldMap,
  serializeAppliedCollectionFilters,
  type AppliedCollectionFilter,
} from "../lib/collection-filters";
import { useAsync, useDebounced } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { useRouter } from "../lib/router";
import { toast } from "../lib/toast";
import { ErrorNote } from "../components/chrome";
import { useConfirm } from "../components/confirm";
import { CollectionFiltersToolbar } from "../components/collection-filters-toolbar";
import { Page, PageBar, PageBody, PageLoader } from "../components/page";
import { openable, stopRowClick } from "../components/row";

interface Page {
  docs: Record<string, unknown>[];
  limit: number;
  totalDocs: number | null;
  hasNextPage: boolean;
}

type Doc = Record<string, unknown>;

const pageSize = 25;

/**
 * One collection, as a table.
 *
 * heyo-ui ships both halves of this: `DataTable`, which filters and sorts an
 * array the browser already has, and `Table`, which is the composable one.
 * This screen is the second case and says so — the rows arrive a page at a
 * time from the engine, so the search box, the sort and the paging are all
 * controlled here and every one of them becomes a query parameter. Sorting a
 * page of twenty-five rows in the browser would reorder the wrong set.
 *
 * The columns come from `admin.defaultColumns` when the configuration names
 * them and from the first few fields when it does not, plus "updated", which
 * is the column every editor actually sorts by. Search remains the readable
 * `?title[ilike]=` query; the filter chips use the API's public `where` tree
 * so negation, multi-value membership and empty fields retain their meaning.
 *
 * Paged with `offset` rather than the keyset cursor on purpose: a table with
 * page numbers needs a total, the engine will only count when asked, and
 * `count=true` plus `offset` is what that combination looks like. Deep paging
 * past a few thousand rows is a search problem, not a pagination one.
 */
export function CollectionList({
  collection,
}: {
  collection: PanelCollection;
}) {
  const { locale, config } = usePanel();
  const { navigate } = useRouter();
  const confirm = useConfirm();

  const [search, setSearch] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<
    AppliedCollectionFilter[]
  >([]);
  const [sort, setSort] = useState<string>("-updatedAt");
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search);

  const titleField = collection.useAsTitle;
  const filterFieldGroups = useMemo(
    () => buildCollectionFilterFieldGroups(collection, config.i18n.locales),
    [collection, config.i18n.locales],
  );
  const filterFieldMap = useMemo(
    () => createCollectionFilterFieldMap(filterFieldGroups),
    [filterFieldGroups],
  );
  const serializedFilters = useMemo(
    () => serializeAppliedCollectionFilters(appliedFilters, filterFieldMap),
    [appliedFilters, filterFieldMap],
  );

  const page = useAsync<Page>(
    (signal) =>
      api.get<Page>(`/${collection.slug}`, {
        signal,
        query: {
          locale,
          limit: pageSize,
          offset,
          sort,
          count: true,
          ...(debounced && titleField
            ? { [`${titleField}[ilike]`]: `%${debounced}%` }
            : {}),
          ...(serializedFilters === undefined
            ? {}
            : { where: serializedFilters }),
        },
      }),
    [collection.slug, locale, offset, sort, debounced, serializedFilters],
  );

  const rows = page.data?.docs ?? [];
  const total = page.data?.totalDocs ?? null;
  const selection = useSelection(rows.map((row) => String(row.id)));

  const columns = useMemo<PanelField[]>(() => {
    const names =
      collection.defaultColumns.length > 0
        ? collection.defaultColumns
        : collection.fields
            .filter((field) => !field.admin.hidden && field.access.read)
            .slice(0, 4)
            .map((field) => field.name);

    return names
      .map((name) => collection.fields.find((field) => field.name === name))
      .filter((field): field is PanelField => field !== undefined);
  }, [collection]);

  /** `-updatedAt` is descending; the header wants `"asc" | "desc" | false`. */
  const sortOf = (id: string): "asc" | "desc" | false =>
    sort === id ? "asc" : sort === `-${id}` ? "desc" : false;

  const toggleSort = (id: string) => {
    setOffset(0);
    setSort((current) => (current === id ? `-${id}` : id));
  };

  const removeSelected = async () => {
    const trashing = config.trash.enabled;
    const count = selection.count;
    const titles = rows
      .filter((row) => selection.isSelected(String(row.id)))
      .slice(0, 5)
      .map((row) => documentTitle(collection, row));

    await confirm({
      title: trashing
        ? `Move ${count} document${count === 1 ? "" : "s"} to the trash?`
        : `Delete ${count} document${count === 1 ? "" : "s"}?`,
      description: trashing
        ? config.trash.purgeAfter
          ? `They stop appearing in lists and the API. The purge sweep removes them ${config.trash.purgeAfter} from now.`
          : "They stop appearing in lists and the API, and can be restored from the trash."
        : "This deployment has no trash, so the rows are removed now. This cannot be undone.",
      consequences: [
        ...titles,
        ...(count > titles.length
          ? [`…and ${count - titles.length} more`]
          : []),
      ],
      confirmLabel: trashing ? `Move ${count} to trash` : `Delete ${count}`,
      destructive: true,
      run: async () => {
        // One at a time rather than in parallel: a bulk delete that half
        // succeeds should stop at the first refusal with the rest intact,
        // not fire twenty requests and report the last error.
        for (const id of selection.selected) {
          await api.delete(`/${collection.slug}/${id}`);
        }
        toast.success(trashing ? "Moved to the trash." : "Deleted.");
        selection.clear();
        await page.reload();
      },
    });
  };

  /** The same compact action in the bar and the table's empty state. */
  const create = () =>
    collection.can.create ? (
      <Button
        size="sm"
        variant="primary"
        icon={IconPlus}
        onClick={() => navigate(`/c/${collection.slug}/new`)}
      >
        New {singular(collection.label)}
      </Button>
    ) : null;

  const selecting = collection.can.delete;
  const columnCount = columns.length + 2 + (selecting ? 1 : 0);
  const bulk = selecting && selection.count > 0;
  const filtering = Boolean(debounced) || appliedFilters.length > 0;

  const clearFilters = () => {
    setOffset(0);
    setSearch("");
    setAppliedFilters([]);
  };

  const crumbs = [
    {
      label: collection.label,
      ...(collection.description ? { hint: collection.description } : {}),
    },
  ];

  // One spinner for the screen, not one per thing being waited on: until
  // the first page lands there is no table to put a row inside, and a
  // toolbar over an empty card is chrome around nothing.
  if (page.loading && !page.data) {
    return (
      <Page>
        <PageBar
          crumbs={crumbs}
          actions={create()}
          usage={{
            kind: "collection",
            name: collection.name,
            slug: collection.slug,
            label: collection.label,
          }}
        />
        <PageLoader />
      </Page>
    );
  }

  return (
    <Page>
      <PageBar
        crumbs={crumbs}
        actions={create()}
        usage={{
          kind: "collection",
          name: collection.name,
          slug: collection.slug,
          label: collection.label,
        }}
      />

      <PageBody>
        <ErrorNote error={page.error} />

        {/* One card: the toolbar, the rows and the footer are one control. */}
        <Card className="overflow-hidden">
          <div
            className={
              bulk
                ? "flex h-13 shrink-0 items-center gap-2 border-b border-heyo-hairline bg-heyo-brand-tint px-3"
                : "flex h-13 shrink-0 items-center gap-2 border-b border-heyo-hairline px-3"
            }
          >
            {bulk ? (
              <>
                <Badge variant="contrast">{selection.count}</Badge>
                <Text size="sm" weight="medium" tone="strong" as="span">
                  selected
                </Text>
                <Button
                  size="sm"
                  variant="ghost"
                  shape="square"
                  icon={IconX}
                  aria-label="Clear selection"
                  onClick={selection.clear}
                />
                <span className="ml-auto">
                  <Button
                    size="sm"
                    variant="destructive-secondary"
                    icon={IconTrash}
                    onClick={() => void removeSelected()}
                  >
                    {config.trash.enabled ? "Trash" : "Delete"}{" "}
                    {selection.count}
                  </Button>
                </span>
              </>
            ) : (
              <CollectionFiltersToolbar
                search={search}
                searchEnabled={titleField !== null}
                searchPlaceholder={`Search ${collection.label.toLowerCase()}…`}
                onSearchChange={(value) => {
                  setOffset(0);
                  setSearch(value);
                }}
                filterFieldGroups={filterFieldGroups}
                appliedFilters={appliedFilters}
                onFiltersChange={(next) => {
                  setOffset(0);
                  setAppliedFilters(next);
                }}
                trailingAction={
                  filtering ? (
                    <Tooltip content="Clear the search and every filter">
                      <Button
                        size="sm"
                        variant="ghost"
                        shape="square"
                        icon={IconFilterOff}
                        aria-label="Clear filters"
                        onClick={clearFilters}
                      />
                    </Tooltip>
                  ) : undefined
                }
              />
            )}
          </div>

          <Table interactive>
            <Table.Head>
              <Table.Row>
                {selecting ? (
                  <Table.SelectHeader>
                    <Checkbox
                      aria-label="Select every row on this page"
                      checked={selection.allSelected}
                      indeterminate={selection.someSelected}
                      onCheckedChange={(next) => selection.toggleAll(next)}
                    />
                  </Table.SelectHeader>
                ) : null}

                {columns.map((field) => (
                  <Table.Header
                    key={field.name}
                    // Column names are uppercase everywhere in the panel, so
                    // a label that arrives from the configuration is
                    // uppercased here rather than trusted to be written that
                    // way in somebody's `fields` array.
                    // A localized column lives in a side table and the engine
                    // will not order by it, so it gets no sort button rather
                    // than one that quietly does nothing.
                    {...(field.localized
                      ? {}
                      : {
                          sort: sortOf(field.name),
                          onSort: () => toggleSort(field.name),
                        })}
                  >
                    {field.label.toUpperCase()}
                  </Table.Header>
                ))}

                <Table.Header />
                <Table.Header
                  align="end"
                  sort={sortOf("updatedAt")}
                  onSort={() => toggleSort("updatedAt")}
                >
                  UPDATED
                </Table.Header>
              </Table.Row>
            </Table.Head>

            <Table.Body>
              {rows.length === 0 ? (
                <Table.Row placeholder>
                  <Table.Cell colSpan={columnCount} className="h-auto p-6">
                    <Empty
                      icon={filtering ? IconSearch : IconFileText}
                      title={
                        filtering
                          ? "Nothing matches"
                          : `No ${collection.label.toLowerCase()} yet`
                      }
                      description={
                        filtering
                          ? "Try a shorter search term, or clear the filters."
                          : collection.can.create
                            ? `Create the first ${singular(collection.label)} and it appears here.`
                            : "Nothing here that your account may read."
                      }
                      action={
                        filtering ? (
                          <Button
                            size="sm"
                            variant="outline"
                            icon={IconFilterOff}
                            onClick={clearFilters}
                          >
                            Clear filters
                          </Button>
                        ) : (
                          (create() ?? undefined)
                        )
                      }
                    />
                  </Table.Cell>
                </Table.Row>
              ) : (
                rows.map((row) => {
                  const id = String(row.id);
                  const scheduled = row.scheduledAt as string | null;
                  return (
                    <Table.Row
                      key={id}
                      selected={selection.isSelected(id)}
                      aria-label={`Open ${documentTitle(collection, row)}`}
                      {...openable(() =>
                        navigate(`/c/${collection.slug}/${id}`),
                      )}
                    >
                      {selecting ? (
                        <Table.SelectCell {...stopRowClick}>
                          <Checkbox
                            aria-label={`Select ${documentTitle(collection, row)}`}
                            checked={selection.isSelected(id)}
                            onCheckedChange={(next) =>
                              selection.toggle(id, next)
                            }
                          />
                        </Table.SelectCell>
                      ) : null}

                      {columns.map((field) => (
                        <Table.Cell
                          key={field.name}
                          primary={field.name === titleField}
                        >
                          {cell(collection, field, row, titleField)}
                        </Table.Cell>
                      ))}

                      <Table.Cell>
                        {scheduled ? (
                          <Badge
                            variant="warning"
                            size="sm"
                            dot
                            title="A scheduled change is waiting for this document."
                          >
                            {formatRelative(scheduled)}
                          </Badge>
                        ) : null}
                      </Table.Cell>

                      <Table.Cell align="end">
                        <Text
                          size="sm"
                          tone="subtle"
                          as="span"
                          className="whitespace-nowrap"
                        >
                          {formatRelative(row.updatedAt as string | null)}
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  );
                })
              )}
            </Table.Body>
          </Table>

          <div className="flex items-center justify-between gap-3 border-t border-heyo-hairline px-3 py-2">
            <Text size="xs" tone="subtle">
              {total === null
                ? `${rows.length} shown`
                : total === 0
                  ? "Nothing to show"
                  : `${Math.min(offset + 1, total)}–${Math.min(offset + pageSize, total)} of ${total}`}
            </Text>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page.data?.hasNextPage !== true}
                onClick={() => setOffset(offset + pageSize)}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      </PageBody>
    </Page>
  );
}

/** "Posts" → "post", so a button reads like the thing it makes. */
function singular(label: string): string {
  const lower = label.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

function cell(
  collection: PanelCollection,
  field: PanelField,
  row: Doc,
  titleField: string | null,
) {
  const value = row[field.name];

  // Plain text, not a link: the row is what opens the document, so a link
  // here would be a second, much smaller target for the same thing.
  if (field.name === titleField) return documentTitle(collection, row);

  if (field.type === "select") {
    return value ? (
      <Badge variant="neutral" size="sm">
        {String(value)}
      </Badge>
    ) : (
      <Text size="sm" tone="inactive" as="span">
        —
      </Text>
    );
  }

  return (
    <Text size="sm" tone="subtle" as="span">
      {cellText(field, value)}
    </Text>
  );
}
