import type { MediaDocument, MediaUsage } from "@heyo-sh/heyo-cms/types";
import {
  Accordion,
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Label,
  ScrollArea,
  Spinner,
  Tabs,
  Text,
  Tooltip,
  cn,
  useSelection,
} from "@heyo-sh/heyo-ui";
import {
  IconChevronRight,
  IconFile,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPhoto,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useId, useRef, useState } from "react";

import { api } from "../lib/api";
import { formatBytes, formatCountdown, formatDateTime } from "../lib/format";
import { useAssistant } from "../lib/assistant";
import { useAssistantPane } from "../lib/assistant-pane";
import { useAsync, useDebounced } from "../lib/hooks";
import { altText, isImage, listMedia, previewUrl, uploadMedia, type MediaPage } from "../lib/media"; // prettier-ignore
import { usePanel } from "../lib/panel";
import { Link } from "../lib/router";
import { toast } from "../lib/toast";
import { usePageContext, usePageTab } from "../components/ai-assistant";
import { ErrorNote } from "../components/chrome";
import { useConfirm } from "../components/confirm";
import { ImageEditor, type Crop, type Focal } from "../components/image-editor";
import { Page, PageBar, PageBody, PageLoader, PageStrip } from "../components/page"; // prettier-ignore

/**
 * The library, with the lifecycle on screen.
 *
 * The second tab is the point of this screen. A file that lost its last
 * reference is `orphaned`, not deleted: it keeps serving until the purge
 * deadline the server set, and "Keep" clears that deadline without
 * pretending anything references it. Showing the countdown is what turns the
 * retention policy into something an editor can act on before a file
 * disappears.
 *
 * Picking a file opens a detail pane beside the grid. It does not dim the
 * library, so choosing the next file is one click. Deletion is the one destructive
 * action here, it asks first with the references named, and it is refused by
 * the server while documents still point at the file — the panel surfaces
 * that refusal rather than offering `?force=true` as a convenience.
 */
const pageSize = 48;

export function MediaLibrary() {
  const { can } = usePanel();
  const {
    open: detailsOpen,
    setOpen: setDetailsOpen,
    assistantOpen,
  } = useAssistantPane();
  const confirm = useConfirm();
  const [tab, setTab] = useState("active");
  const [selected, setSelected] = useState<MediaDocument | null>(null);
  const [mediaDirtyFields, setMediaDirtyFields] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search);
  // Media exposes a keyset cursor, not an offset or a total count. Retain
  // each page's starting cursor to make Previous work without guessing an
  // offset that the API does not support.
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[pageIndex] ?? null;
  const queryKey = JSON.stringify([tab, cursor, debouncedSearch]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // The file in the details pane is what "this image" means on this screen.
  // Without it the assistant can search the library but cannot act on the
  // one thing the editor is pointing at, which is the only reason they would
  // ask here rather than anywhere else. Re-read server-side through
  // `cms.media`: file metadata is publicly readable in this CMS, and the id
  // is a pointer to the current file rather than metadata from the browser.
  usePageContext({
    kind: "media",
    ...(selected ? { mediaId: selected.id } : {}),
    ...(selected && mediaDirtyFields.length > 0
      ? { dirtyFields: mediaDirtyFields }
      : {}),
  });
  usePageTab(tab);

  // Read inside the mutation listener below, which is registered once and
  // must not close over a stale selection.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dirtyRef = useRef(mediaDirtyFields);
  dirtyRef.current = mediaDirtyFields;

  const files = useAsync<MediaPage & { queryKey: string }>(
    async (signal) => ({
      ...(await listMedia(
        {
          status: tab === "orphaned" ? "orphaned" : "active",
          limit: pageSize,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(cursor ? { cursor } : {}),
        },
        signal,
      )),
      queryKey,
    }),
    [tab, cursor, debouncedSearch],
  );

  // useAsync retains its last value until the next effect runs. A cursor or
  // search change must never briefly paint files from the old result set.
  const pending =
    search !== debouncedSearch ||
    files.loading ||
    (!files.error && files.data?.queryKey !== queryKey);
  const page =
    !pending && !files.error && files.data?.queryKey === queryKey
      ? files.data
      : null;
  const rows = page?.docs ?? [];
  const selection = useSelection(rows.map((file) => file.id));
  const selectable = can("media:delete");
  const canUpload = can("media:create");
  const bulk = selectable && selection.count > 0;

  // The agent writes through the same endpoints this screen does, so a file
  // it renames is one the details pane may be showing. Now that "this image"
  // resolves to the selection, this is the likeliest agent write on the
  // screen: the editor asks for alt text, gets it, and would otherwise be
  // reading the old value under a card that says it was saved.
  const { onMutation } = useAssistant();
  useEffect(() => {
    return onMutation((notice) => {
      if (notice.target.kind !== "media") return;
      void files.reload();
      const open = selectedRef.current;
      if (!open || notice.target.id !== open.id) return;
      if (dirtyRef.current.length > 0) {
        toast.info("The assistant changed this file while you were editing.");
        return;
      }
      void api
        .get<MediaDocument>(`/media/${open.id}`)
        .then((fresh) => {
          // Still the same file: the editor may have clicked another one
          // while the read was in flight.
          if (selectedRef.current?.id === fresh.id) setSelected(fresh);
        })
        .catch(() => {
          // A file that cannot be re-read was deleted or hidden from this
          // actor. The list reload above is what answers that.
        });
    });
  }, [files, onMutation]);

  const changeSearch = (value: string) => {
    selection.clear();
    setSelected(null);
    setCursors([null]);
    setPageIndex(0);
    setSearch(value);
  };

  const previousPage = () => {
    if (pageIndex === 0) return;
    selection.clear();
    setSelected(null);
    setPageIndex((current) => current - 1);
  };

  const nextPage = () => {
    const next = page?.cursor;
    if (!page?.hasNextPage || !next) {
      return;
    }
    selection.clear();
    setSelected(null);
    setCursors((current) => [...current.slice(0, pageIndex + 1), next]);
    setPageIndex((current) => current + 1);
  };

  const refreshAfterRemoval = (removed: string[]) => {
    if (removed.length === 0) return;
    selection.clear();
    if (selected && removed.includes(selected.id)) setSelected(null);
    // A deleted last page cannot be reloaded using its old cursor as an
    // empty page. Walk back to the previous page instead.
    if (
      pageIndex > 0 &&
      rows.length > 0 &&
      rows.every((file) => removed.includes(file.id))
    ) {
      setPageIndex((current) => current - 1);
    } else {
      void files.reload();
    }
  };

  const removeSelected = async () => {
    const chosen = rows.filter((file) => selection.isSelected(file.id));
    if (chosen.length === 0) return;
    // The confirmation stays open on a refusal. Retrying must skip the files
    // already deleted before that refusal, rather than failing on their 404s.
    const remaining = [...chosen];
    await confirm({
      title: `Delete ${chosen.length} file${chosen.length === 1 ? "" : "s"}?`,
      description:
        "The bytes are removed from storage. Files referenced by documents cannot be deleted; the server will refuse them.",
      consequences: [
        ...chosen.slice(0, 5).map((file) => (
          <span className="block min-w-0 truncate" title={file.filename}>
            {file.filename}
          </span>
        )),
        ...(chosen.length > 5 ? [`…and ${chosen.length - 5} more`] : []),
      ],
      confirmLabel: `Delete ${chosen.length}`,
      destructive: true,
      run: async () => {
        const removed: string[] = [];
        try {
          // Stop at the first refusal rather than firing every deletion at
          // once; the confirmation dialog displays the failing request.
          while (remaining.length > 0) {
            const file = remaining[0]!;
            await api.delete(`/media/${file.id}`);
            removed.push(file.id);
            remaining.shift();
          }
          toast.success(`${chosen.length} file${chosen.length === 1 ? "" : "s"} deleted.`); // prettier-ignore
        } finally {
          // Even a partial success must remove deleted files from the grid.
          refreshAfterRemoval(removed);
        }
      },
    });
  };

  const upload = async (list: FileList | File[] | null) => {
    const chosen = list ? Array.from(list) : [];
    if (chosen.length === 0 || !canUpload) return;
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of chosen) {
        await uploadMedia(file);
        uploaded += 1;
      }
      toast.success(
        chosen.length === 1 ? (
          <span className="block min-w-0 truncate" title={chosen[0]!.name}>
            {chosen[0]!.name} uploaded.
          </span>
        ) : (
          `${chosen.length} files uploaded.`
        ),
      );
    } catch (error) {
      toast.error(error);
    } finally {
      if (uploaded > 0) {
        selection.clear();
        setSelected(null);
        // New uploads are active and newest first. Return to the unfiltered
        // first page so the newly uploaded files are actually visible.
        const sameQuery =
          tab === "active" && pageIndex === 0 && debouncedSearch === "";
        setTab("active");
        setSearch("");
        setCursors([null]);
        setPageIndex(0);
        if (sameQuery) await files.reload();
      }
      setUploading(false);
    }
  };

  /**
   * One file input for the screen, and a button that opens it.
   *
   * The two are separate because the button is drawn twice — in the bar and
   * in the empty state — and a second copy of the `<input>` would steal the
   * ref from the first.
   */
  const uploadInput = (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      onChange={(event) => void upload(event.target.files)}
    />
  );

  const uploadButton = () => (
    <Button
      size="sm"
      variant="primary"
      icon={IconUpload}
      loading={uploading}
      onClick={() => input.current?.click()}
    >
      Upload
    </Button>
  );

  return (
    <Page>
      <PageBar
        crumbs={[{ label: "Media" }]}
        locale={false}
        usage={{
          kind: "media",
          status: tab === "orphaned" ? "orphaned" : "active",
        }}
        actions={
          canUpload ? (
            <>
              {uploadInput}
              {uploadButton()}
            </>
          ) : null
        }
      />

      {/* The two lifecycle views are chrome, so they sit in the bar's own
          strip rather than floating at the top of the content. */}
      <PageStrip>
        <Tabs
          variant="segmented"
          value={tab}
          onValueChange={(value) => {
            selection.clear();
            setSelected(null);
            setCursors([null]);
            setPageIndex(0);
            setTab(String(value));
          }}
        >
          <Tabs.List
            items={[
              { value: "active", label: "Library" },
              { value: "orphaned", label: "Unused" },
            ]}
          />
        </Tabs>
      </PageStrip>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]">
        <PageBody className="min-w-0">
          <ErrorNote error={files.error} />

          <Card className="overflow-hidden">
            <div
              className={cn(
                "flex h-13 shrink-0 items-center gap-2 border-b border-heyo-hairline px-3",
                bulk && "bg-heyo-brand-tint",
              )}
            >
              {bulk ? (
                <>
                  <Checkbox
                    aria-label="Select every file on this page"
                    checked={selection.allSelected}
                    indeterminate={selection.someSelected}
                    onCheckedChange={(next) => selection.toggleAll(next)}
                  />
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
                      Delete {selection.count}
                    </Button>
                  </span>
                </>
              ) : (
                <>
                  <Input
                    size="sm"
                    icon={IconSearch}
                    value={search}
                    onChange={(event) => changeSearch(event.target.value)}
                    placeholder="Search media…"
                    aria-label="Search media"
                    className="w-56 max-w-full min-w-0"
                  />
                  {search ? (
                    <Tooltip content="Clear search">
                      <Button
                        size="sm"
                        shape="square"
                        variant="ghost"
                        icon={IconX}
                        aria-label="Clear media search"
                        onClick={() => changeSearch("")}
                      />
                    </Tooltip>
                  ) : null}
                  {selectable ? (
                    <Tooltip content="Select every file on this page">
                      <Checkbox
                        aria-label="Select every file on this page"
                        checked={selection.allSelected}
                        indeterminate={selection.someSelected}
                        disabled={rows.length === 0}
                        onCheckedChange={(next) => selection.toggleAll(next)}
                      />
                    </Tooltip>
                  ) : null}
                </>
              )}
            </div>

            {/* The whole grid is the drop target: a 180px dashed box in the
            corner is a smaller target than the thing people aim at anyway. */}
            <div
              className={cn(
                "relative p-3 transition-colors",
                dragging && "bg-heyo-brand-tint ring-2 ring-heyo-focus",
              )}
              onDragOver={(event) => {
                if (!canUpload) return;
                event.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) {
                  return;
                }
                setDragging(false);
              }}
              onDrop={(event) => {
                if (!canUpload) return;
                event.preventDefault();
                setDragging(false);
                void upload(event.dataTransfer.files);
              }}
            >
              {dragging ? (
                <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
                  <Badge variant="brand" icon={IconUpload}>
                    Drop to upload
                  </Badge>
                </div>
              ) : null}

              {pending ? (
                <PageLoader />
              ) : files.error ? null : rows.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {rows.map((file) => (
                    <FileCard
                      key={file.id}
                      file={file}
                      selected={selected?.id === file.id}
                      checked={selection.isSelected(file.id)}
                      selectable={selectable}
                      onSelect={() => {
                        setSelected(file);
                        // Like navigating to another document: a newly chosen
                        // file starts folded if the assistant is already open.
                        setDetailsOpen(!assistantOpen);
                      }}
                      onCheck={(checked) => selection.toggle(file.id, checked)}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon={IconPhoto}
                  title={
                    pageIndex > 0
                      ? "No files on this page"
                      : search
                        ? "Nothing matches"
                        : tab === "orphaned"
                          ? "Nothing unused"
                          : "The library is empty"
                  }
                  description={
                    pageIndex > 0
                      ? "Go back to the previous page."
                      : search
                        ? "Try a shorter filename or clear the search."
                        : tab === "orphaned"
                          ? "Every file is referenced by at least one document."
                          : "Drop files here, or press Upload."
                  }
                  action={
                    search ? (
                      <Button
                        size="sm"
                        variant="outline"
                        icon={IconX}
                        onClick={() => changeSearch("")}
                      >
                        Clear search
                      </Button>
                    ) : tab === "orphaned" ||
                      pageIndex > 0 ||
                      !canUpload ? undefined : (
                      uploadButton()
                    )
                  }
                />
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-heyo-hairline px-3 py-2">
              <Text size="xs" tone="subtle">
                {pending
                  ? "Loading…"
                  : files.error
                    ? "Unable to load files"
                    : rows.length === 0
                      ? "Nothing to show"
                      : `Page ${pageIndex + 1} · ${rows.length} shown`}
              </Text>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageIndex === 0 || pending}
                  onClick={previousPage}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!page?.hasNextPage || !page.cursor}
                  onClick={nextPage}
                >
                  Next
                </Button>
              </div>
            </div>
          </Card>
        </PageBody>

        <MediaDetail
          file={selected}
          open={detailsOpen}
          onToggle={() => setDetailsOpen((current) => !current)}
          onClose={() => setSelected(null)}
          onDirtyFieldsChange={setMediaDirtyFields}
          onChanged={async (next) => {
            setSelected(next);
            await files.reload();
          }}
          onDeleted={async (id) => {
            refreshAfterRemoval([id]);
          }}
        />
      </div>
    </Page>
  );
}

function FileCard({
  file,
  selected,
  checked,
  selectable,
  onSelect,
  onCheck,
}: {
  file: MediaDocument;
  selected: boolean;
  checked: boolean;
  selectable: boolean;
  onSelect: () => void;
  onCheck: (checked: boolean) => void;
}) {
  const { config } = usePanel();

  return (
    <div
      className={cn(
        "group/file relative overflow-hidden rounded-xl bg-heyo-base",
        "transition-[background-color,box-shadow] duration-100 ease-heyo",
        selected || checked ? "bg-heyo-brand-tint" : "hover:bg-heyo-tint",
      )}
    >
      {/* Separate siblings: a checkbox nested in the preview button would
          activate the details pane and create invalid nested buttons. */}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Open ${file.filename} details`}
        className="block w-full cursor-pointer text-left heyo-focus"
      >
        <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden bg-heyo-recessed">
          {isImage(file) ? (
            <img
              src={previewUrl(file, config.media.variants)}
              alt={altText(file, config.i18n.defaultLocale)}
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover/file:scale-[1.03]"
            />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <IconFile className="size-6 text-heyo-inactive" />
              <Text size="xs" tone="inactive" as="span">
                {file.mimeType.split("/").at(-1)?.toUpperCase()}
              </Text>
            </div>
          )}

          {file.status === "orphaned" ? (
            <span className="absolute top-1.5 right-1.5">
              <Badge
                size="sm"
                variant={file.purgeAfter === null ? "neutral" : "warning"}
              >
                {formatCountdown(file.purgeAfter)}
              </Badge>
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 px-2.5 py-2">
          <Text
            size="xs"
            truncate
            className="min-w-0 flex-1"
            title={file.filename}
          >
            {file.filename}
          </Text>
          <Text size="xs" tone="subtle" as="span" className="shrink-0">
            {file.width
              ? `${file.width}×${file.height}`
              : formatBytes(file.size)}
          </Text>
        </div>
      </button>
      {selectable ? (
        <span className="absolute top-2 left-2 z-10 flex rounded-md bg-heyo-base/90 p-1 shadow-xs">
          <Checkbox
            aria-label={`Select ${file.filename}`}
            checked={checked}
            onCheckedChange={onCheck}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * One file: its metadata, its framing and where it is used.
 *
 * It lives in the page grid, just like the document fields pane. That makes
 * room for it instead of covering the library, and lets it give its space to
 * the AI assistant whenever it opens, while keeping a trigger in a narrow
 * rail to let the editor reopen it beside the chat. Only deselecting the file
 * closes the pane to zero width; the draft stays mounted during either fold.
 */
function MediaDetail({
  file,
  open,
  onToggle,
  onClose,
  onDirtyFieldsChange,
  onChanged,
  onDeleted,
}: {
  file: MediaDocument | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDirtyFieldsChange: (fields: string[]) => void;
  onChanged: (file: MediaDocument) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}) {
  const { config, can } = usePanel();
  const confirm = useConfirm();
  const [filename, setFilename] = useState("");
  const [focal, setFocal] = useState<Focal | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const filenameId = useId();
  const loadedFor = useRef<string | null>(null);
  const lastFile = useRef<MediaDocument | null>(null);

  // Keep the last file painted while the pane folds away. Clearing the
  // contents in the same frame as the selection made a blank white column
  // animate closed, unlike every other sidebar in the panel.
  if (file) lastFile.current = file;
  const displayedFile = file ?? lastFile.current;

  // The pane is one component reused for every file, so the draft has to be
  // re-seeded when the selection changes — during render rather than in an
  // effect, or the previous file's filename is briefly shown against the new
  // file's picture.
  if (file && loadedFor.current !== file.id) {
    loadedFor.current = file.id;
    setFilename(file.filename);
    setFocal(file.focalPoint);
    setCrop(file.crop);
    setError(null);
  }

  const usages = useAsync(
    (signal) =>
      displayedFile
        ? api.get<{ usages: MediaUsage[] }>(
            `/media/${displayedFile.id}/usages`,
            { signal },
          )
        : Promise.resolve({ usages: [] }),
    [displayedFile?.id],
  );

  const visible = file !== null && open;
  const state = file === null ? "empty" : open ? "expanded" : "collapsed";

  const dirtyFields = file
    ? [
        ...(filename === file.filename ? [] : ["filename"]),
        ...(JSON.stringify(focal) === JSON.stringify(file.focalPoint)
          ? []
          : ["focalPoint"]),
        ...(JSON.stringify(crop) === JSON.stringify(file.crop) ? [] : ["crop"]),
      ]
    : [];
  const dirty = dirtyFields.length > 0;
  // Only names leave the browser, exactly as for document forms. Keying on
  // their contents avoids registering the same array on every render.
  const dirtyKey = dirtyFields.join(",");
  useEffect(() => {
    onDirtyFieldsChange(dirtyKey ? dirtyKey.split(",") : []);
  }, [dirtyKey, file?.id, onDirtyFieldsChange]);

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<MediaDocument>(`/media/${file.id}`, {
        body: {
          filename,
          ...(config.media.focalPoint ? { focalPoint: focal } : {}),
          ...(config.media.crop ? { crop } : {}),
        },
      });
      toast.success("Saved.");
      loadedFor.current = null;
      await onChanged(updated);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const keep = async () => {
    if (!file) return;
    try {
      const updated = await api.post<MediaDocument>(`/media/${file.id}/keep`);
      toast.success("Kept — the purge deadline is cleared.");
      loadedFor.current = null;
      await onChanged(updated);
    } catch (cause) {
      toast.error(cause);
    }
  };

  const remove = async () => {
    if (!file) return;
    const references = usages.data?.usages.length ?? 0;
    await confirm({
      title: `Delete ${file.filename}?`,
      description:
        references > 0
          ? "The server refuses to delete a file that documents still point at — this will almost certainly fail, and the refusal names them."
          : "The bytes are removed from storage. This cannot be undone.",
      consequences:
        references > 0
          ? [`${references} document${references === 1 ? "" : "s"} reference it.`] // prettier-ignore
          : [`${formatBytes(file.size)}${file.width ? ` · ${file.width}×${file.height}` : ""}`], // prettier-ignore
      confirmLabel: "Delete",
      destructive: true,
      run: async () => {
        // 409 with the documents named: the refusal is the useful part, and
        // it lands inside the dialog rather than as a toast over a grid.
        await api.delete(`/media/${file.id}`);
        toast.success("Deleted.");
        loadedFor.current = null;
        await onDeleted(file.id);
      },
    });
  };

  return (
    <aside
      aria-label="Media details"
      aria-hidden={file === null}
      data-state={state}
      {...(file === null ? { inert: true } : {})}
      className={cn(
        "flex min-h-0 min-w-0 w-full flex-col overflow-hidden bg-heyo-base",
        "[--media-details-width:20rem] xl:[--media-details-width:24rem]",
        "lg:h-full lg:w-(--media-details-width) lg:border-l lg:border-heyo-hairline",
        "lg:transition-[width] lg:duration-(--heyo-sidebar-duration) lg:ease-heyo",
        "lg:data-[state=collapsed]:w-(--heyo-sidebar-width-icon)",
        "lg:data-[state=empty]:w-0",
        "motion-reduce:transition-none",
        file === null && "max-lg:hidden",
        // On phones the AI drawer owns the viewport. When folded manually,
        // selecting the tile again reopens details without a blank grid row.
        file !== null && !open && "max-md:hidden",
      )}
    >
      <header className="flex h-[3.125rem] w-full shrink-0 items-center gap-1.5 border-b border-heyo-hairline px-2.5 lg:w-(--media-details-width)">
        <Tooltip content={open ? "Hide media details" : "Show media details"}>
          <Button
            size="base"
            shape="square"
            variant="ghost"
            icon={
              open
                ? IconLayoutSidebarRightCollapse
                : IconLayoutSidebarRightExpand
            }
            aria-label={open ? "Hide media details" : "Show media details"}
            aria-expanded={visible}
            onClick={onToggle}
          />
        </Tooltip>
        <div
          {...(visible ? {} : { inert: true })}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 transition-[opacity,visibility] duration-(--heyo-sidebar-duration) ease-heyo",
            "motion-reduce:transition-none",
            !visible && "invisible opacity-0",
          )}
        >
          <Text size="sm" className="min-w-0 flex-1 truncate">
            Media details
          </Text>
          <Tooltip content="Close media details">
            <Button
              size="base"
              shape="square"
              variant="ghost"
              icon={IconX}
              aria-label="Close media details"
              onClick={onClose}
            />
          </Tooltip>
        </div>
      </header>

      <ScrollArea
        fade={false}
        // Base UI gives its inner content min-width: fit-content. An
        // unbroken filename can then widen the whole pane before Text's
        // truncate ever gets a bounded width. Override that intrinsic width
        // here (only for media details), not just the visible viewport.
        {...(visible ? {} : { inert: true })}
        className={cn(
          "min-h-0 w-full min-w-0 flex-1 lg:w-(--media-details-width) [&_[data-slot=scroll-area-content]]:w-full [&_[data-slot=scroll-area-content]]:!min-w-0",
          "transition-[opacity,visibility] duration-(--heyo-sidebar-duration) ease-heyo",
          "motion-reduce:transition-none",
          !visible && "invisible opacity-0 max-lg:hidden",
        )}
        viewportClassName="overflow-x-hidden"
      >
        {displayedFile ? (
          <>
            <div className="w-full min-w-0 max-w-full overflow-hidden px-4 pt-4 pb-5">
              <section className="min-w-0 space-y-4">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Text
                      size="sm"
                      weight="medium"
                      truncate
                      title={displayedFile.filename}
                      className="min-w-0 flex-1"
                    >
                      {compactFilename(displayedFile.filename)}
                    </Text>
                    {displayedFile.status === "orphaned" ? (
                      <Badge variant="warning" size="sm" dot>
                        unused
                      </Badge>
                    ) : null}
                  </div>
                  <Text size="xs" tone="subtle" truncate>
                    {displayedFile.mimeType} · {formatBytes(displayedFile.size)}
                    {displayedFile.width
                      ? ` · ${displayedFile.width}×${displayedFile.height}`
                      : ""}
                  </Text>
                </div>

                {isImage(displayedFile) ? (
                  <ImageEditor
                    key={displayedFile.id}
                    file={displayedFile}
                    focal={focal}
                    crop={crop}
                    onFocalChange={setFocal}
                    onCropChange={setCrop}
                    allowFocal={config.media.focalPoint}
                    allowCrop={config.media.crop}
                  />
                ) : (
                  <div className="flex min-w-0 items-center gap-3 rounded-lg bg-heyo-recessed p-3">
                    <IconFile className="size-5 text-heyo-subtle" />
                    <Text size="sm" tone="subtle">
                      No preview or framing controls are available for this file
                      type.
                    </Text>
                  </div>
                )}
              </section>
            </div>

            <Accordion
              multiple
              defaultValue={["properties"]}
              key={displayedFile.id}
            >
              <Accordion.Item value="properties">
                <Accordion.Trigger className="px-4">
                  Properties
                </Accordion.Trigger>
                <Accordion.Content className="px-4">
                  <div className="space-y-4 pt-1">
                    <div className="flex min-w-0 items-start gap-3">
                      <Label
                        htmlFor={filenameId}
                        className="flex min-h-8 w-24 shrink-0 items-center text-heyo-subtle"
                      >
                        Filename
                      </Label>
                      <Input
                        id={filenameId}
                        value={filename}
                        className="min-w-0 max-w-full flex-1 text-ellipsis"
                        title={filename}
                        onChange={(event) => setFilename(event.target.value)}
                      />
                    </div>

                    {displayedFile.status === "orphaned" ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg bg-heyo-warning-tint p-2.5 ring-1 ring-heyo-warning/25">
                        <Text size="xs" className="text-heyo-warning">
                          Nothing references this file.{" "}
                          {formatCountdown(displayedFile.purgeAfter)}.
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => void keep()}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </Accordion.Content>
              </Accordion.Item>

              <Accordion.Item value="information">
                <Accordion.Trigger className="px-4">
                  File information
                </Accordion.Trigger>
                <Accordion.Content className="px-4">
                  <dl className="m-0 min-w-0 space-y-2 pt-1">
                    <Detail label="Type" value={displayedFile.mimeType} />
                    <Detail
                      label="Size"
                      value={formatBytes(displayedFile.size)}
                    />
                    <Detail
                      label="Dimensions"
                      value={
                        displayedFile.width
                          ? `${displayedFile.width}×${displayedFile.height}`
                          : "—"
                      }
                    />
                    <Detail
                      label="Uploaded"
                      value={formatDateTime(displayedFile.createdAt)}
                    />
                    <Detail
                      label="Updated"
                      value={formatDateTime(displayedFile.updatedAt)}
                    />
                    <Detail
                      label="Variants"
                      value={
                        displayedFile.variants.length > 0
                          ? displayedFile.variants.join(", ")
                          : config.media.variantMode === "on-demand"
                            ? "rendered on first request"
                            : "—"
                      }
                    />
                    <Detail label="ID" value={displayedFile.id} />
                  </dl>
                </Accordion.Content>
              </Accordion.Item>

              <Accordion.Item value="usages">
                <Accordion.Trigger className="px-4">
                  <span className="flex w-full items-center justify-between gap-2">
                    Used in
                    {usages.data ? (
                      <Badge variant="count" size="sm">
                        {usages.data.usages.length}
                      </Badge>
                    ) : null}
                  </span>
                </Accordion.Trigger>
                <Accordion.Content className="px-4">
                  <div className="space-y-2 pt-1">
                    <ErrorNote error={usages.error} />
                    {usages.loading ? (
                      <div className="flex h-10 items-center justify-center">
                        <Spinner size="sm" />
                      </div>
                    ) : usages.data && usages.data.usages.length > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {usages.data.usages.map((usage) => (
                          <MediaUsageRow
                            key={`${usage.collection}-${usage.documentId}-${usage.field}-${usage.locale}`}
                            usage={usage}
                          />
                        ))}
                      </ul>
                    ) : (
                      <Text size="xs" tone="subtle">
                        Nothing points at it yet.
                      </Text>
                    )}
                  </div>
                </Accordion.Content>
              </Accordion.Item>
            </Accordion>
            <div className="px-4 pb-5">
              <ErrorNote error={error} className="mt-5" />
            </div>
          </>
        ) : null}
      </ScrollArea>

      <footer
        {...(visible ? {} : { inert: true })}
        className={cn(
          "flex h-[3.125rem] shrink-0 items-center justify-between border-t border-heyo-hairline bg-heyo-base px-4 lg:w-(--media-details-width)",
          "transition-[opacity,visibility] duration-(--heyo-sidebar-duration) ease-heyo",
          "motion-reduce:transition-none",
          !visible && "invisible opacity-0 max-lg:hidden",
        )}
      >
        {can("media:delete") ? (
          <Tooltip content="Deleting is refused while a document still points at it">
            <Button
              size="sm"
              variant="destructive-secondary"
              icon={IconTrash}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </Tooltip>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!dirty || busy || !can("media:update")}
          onClick={() => void save()}
        >
          Save changes
        </Button>
      </footer>
    </aside>
  );
}

function MediaUsageRow({ usage }: { usage: MediaUsage }) {
  const { config } = usePanel();
  const collection = config.collections.find(
    (entry) => entry.slug === usage.collection,
  );
  const row = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-heyo-recessed text-heyo-subtle">
        <IconFile className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Text size="xs" weight="medium" as="span" truncate>
          {collection?.label ?? usage.collection}
        </Text>
        <Text
          size="xs"
          tone="subtle"
          as="span"
          truncate
          title={`${usage.documentId} · ${usage.field}${usage.locale ? ` · ${usage.locale}` : ""}`}
        >
          {usage.field}
          {usage.locale ? ` · ${usage.locale}` : ""} · {usage.documentId}
        </Text>
      </span>
      {collection ? (
        <IconChevronRight className="size-3.5 shrink-0 text-heyo-inactive" />
      ) : null}
    </>
  );

  return (
    <li className="min-w-0">
      {collection ? (
        <Link
          to={`/c/${collection.slug}/${usage.documentId}`}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 transition-colors duration-100 hover:bg-heyo-tint heyo-focus"
        >
          {row}
        </Link>
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-2 py-2">{row}</div>
      )}
    </li>
  );
}

/** Keep a recognisable start and the extension without growing the sidebar. */
function compactFilename(filename: string): string {
  const characters = Array.from(filename);
  if (characters.length <= 44) return filename;
  return `${characters.slice(0, 28).join("")}…${characters.slice(-12).join("")}`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <Text size="xs" tone="subtle" as="dt" className="w-24 shrink-0">
        {label}
      </Text>
      <Text
        size="xs"
        as="dd"
        className="m-0 min-w-0 flex-1 truncate text-right"
        title={value}
      >
        {value}
      </Text>
    </div>
  );
}
