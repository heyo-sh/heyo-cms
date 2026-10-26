import type { PanelCollection } from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  Calendar,
  Dialog,
  Dropdown,
  Input,
  Kbd,
  Text,
  Tooltip,
  startOfDay,
} from "@heyo-sh/heyo-ui";
import {
  IconCalendarClock,
  IconDeviceFloppy,
  IconDots,
  IconRotateClockwise,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../lib/api";
import { useAssistant } from "../lib/assistant";
import { documentTitle, formatDateTime, formatRelative } from "../lib/format";
import { useAsync, useHotkey, useUnsavedWarning } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { Link, useNavigationBlock, useRouter } from "../lib/router";
import { toast } from "../lib/toast";
import { sameValue } from "../lib/value";
import { usePageContext } from "../components/ai-assistant";
import { ErrorNote } from "../components/chrome";
import { useConfirm } from "../components/confirm";
import { DocumentForm, splitFields } from "../components/document-form"; // prettier-ignore
import { DocumentEditorLayout } from "../components/document-editor-layout";
import { useLocaleVariant } from "../components/locale-variant";
import { Page, PageBar, PageBody, PageLoader } from "../components/page";

type Doc = Record<string, unknown>;

/**
 * One document: the form, and the four things that can happen to it.
 *
 * Save, delete, schedule, restore — and **no autosave**, which is a decision
 * rather than an omission. The editor holds a draft in memory, the bar says
 * it is unsaved, ⌘S writes it, and leaving with unsaved work asks first.
 * Publishing is not among the four: it is a write to a field called `status`,
 * which is why there is no publish button anywhere in this file and no
 * publish endpoint anywhere in the API.
 *
 * The layout follows the content. Any `richText` field is a writing surface
 * on the left; every remaining field sits in the fields pane on the right.
 * More than one writing surface becomes a tab, while a record without one
 * stays a single, centred form.
 *
 * Only changed fields are sent. A `PATCH` with the whole document would
 * overwrite a field somebody else edited while this tab was open, and it
 * would fight field-level access by sending values the actor may not write.
 */
export function DocumentEdit({
  collection,
  id,
}: {
  collection: PanelCollection;
  id: string | null;
}) {
  const { locale, config } = usePanel();
  const { navigate } = useRouter();
  const localized = collection.fields.some((field) => field.localized);
  const confirm = useConfirm();

  const [draft, setDraft] = useState<Doc>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  /** The appointed hour, as the two controls that pick it hold it. */
  const [scheduleDay, setScheduleDay] = useState<Date | null>(null);
  const [scheduleTime, setScheduleTime] = useState("09:00");
  /** Set by a 409: somebody else wrote while this form was open. */
  const [conflict, setConflict] = useState(false);
  const variant = useLocaleVariant({
    collection,
    ...(id ? { id } : {}),
    dirty: dirty.size > 0,
    confirmDiscard: () =>
      id
        ? confirm({
            title: "Save before switching languages?",
            description:
              "Save your current edits before opening or creating another language version.",
            confirmLabel: "Save and continue",
            cancelLabel: "Keep editing",
            run: async () => {
              if (!(await save()))
                throw new Error(
                  "The document could not be saved. Your draft is still here.",
                );
            },
          })
        : confirm({
            title: "Leave without saving?",
            description: "Switching languages discards your unsaved fields.",
            confirmLabel: "Discard changes",
            cancelLabel: "Keep editing",
            destructive: true,
          }),
  });

  const loaded = useAsync<Doc | null>(
    async (signal) =>
      id
        ? api.get<Doc>(`/${collection.slug}/${id}`, {
            signal,
            query: { locale, depth: 0, includeTrashed: true },
          })
        : null,
    [collection.slug, id, locale],
  );

  /**
   * What the form was given: the stored document, or the configuration's
   * defaults for a record that does not exist yet.
   *
   * Every "has this changed?" question is asked against this and nothing
   * else, which is what keeps the unsaved badge honest.
   */
  const baseline = useMemo(
    () => loaded.data ?? defaults(collection),
    [loaded.data, collection],
  );

  // A locale switch reloads the document in that language, and the draft has
  // to follow it: the values on screen are one language's values.
  useEffect(() => {
    setDraft(baseline);
    setDirty(new Set());
    setConflict(false);
  }, [baseline, locale]);

  // The revision this form was loaded from. Sent with every save, so a save
  // that would overwrite somebody else's work is refused instead.
  const baselineRevision =
    typeof loaded.data?.revision === "number" ? loaded.data.revision : null;

  // What the assistant is told the editor is looking at. Names of unsaved
  // fields travel; their values never do.
  usePageContext({
    kind: "document",
    collectionSlug: collection.slug,
    ...(id ? { documentId: id } : {}),
    ...(dirty.size > 0 ? { dirtyFields: [...dirty] } : {}),
    ...(baselineRevision === null ? {} : { baselineRevision }),
  });

  // Read inside the mutation listener below, which is registered once and
  // must not close over a stale `dirty`. Declared before the effect that uses
  // it so the order on the page matches the order of the reasoning.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // The agent writes through the same API this form does, so a record on
  // screen can change underneath it. A clean form catches up silently; a
  // dirty one is never overwritten and says so.
  const { onMutation } = useAssistant();
  useEffect(() => {
    return onMutation((notice) => {
      if (notice.target.kind !== "document") return;
      if (notice.target.collectionSlug !== collection.slug) return;
      if (notice.target.id !== id) return;
      if (dirtyRef.current.size > 0) {
        setConflict(true);
        toast.info("The assistant changed this document while you were editing."); // prettier-ignore
        return;
      }
      void loaded.reload();
    });
  }, [collection.slug, id, loaded, onMutation]);

  useUnsavedWarning(dirty.size > 0);

  // The same question the browser asks on a close, in the panel's words and
  // with the option that actually helps: save it first.
  useNavigationBlock(dirty.size > 0, async () => {
    const stay = await confirm({
      title: "Leave without saving?",
      description: `${dirty.size} field${dirty.size === 1 ? "" : "s"} changed since the last save.`,
      consequences: [`Unsaved: ${[...dirty].join(", ")}.`],
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    return stay;
  });

  const fallback = (loaded.data?._fallback ?? undefined) as
    Record<string, string> | undefined;
  const trashed = typeof loaded.data?.deletedAt === "string";
  const scheduled = loaded.data?.scheduledAt as string | null | undefined;

  /**
   * A control reported a value. Whether that is an edit is decided here, by
   * the only test that means anything: does it still equal what the server
   * gave us?
   *
   * Controls report values they were not asked to change. The rich-text
   * field re-serialises its document when it mounts and when ProseMirror
   * tidies up after itself, and a value that has been through a JSON column
   * can come back with its keys in another order. Treating every report as
   * an edit is what made a freshly created document say "unsaved" the moment
   * it had finished saving — and kept saying it on every later visit.
   *
   * The test runs in both directions, so typing a character and deleting it
   * again leaves the field clean rather than permanently dirty.
   */
  const change = (name: string, value: unknown) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setDirty((current) => {
      const edited = !sameValue(value, baseline[name]);
      if (edited === current.has(name)) return current;
      const next = new Set(current);
      if (edited) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const patch = useMemo(() => {
    const result: Doc = {};
    for (const name of dirty) result[name] = draft[name] ?? null;
    return result;
  }, [dirty, draft]);

  const canWrite = id ? collection.can.update : collection.can.create;
  const savable = canWrite && !saving && (id === null || dirty.size > 0);

  const save = async (): Promise<boolean> => {
    if (!savable) return false;
    setSaving(true);
    try {
      const document = id
        ? await api.patch<Doc | null>(`/${collection.slug}/${id}`, {
            query: { locale },
            // The precondition. Without it the last tab to press Save wins,
            // silently, including against the assistant.
            body: {
              data: patch,
              ...(baselineRevision === null
                ? {}
                : { revision: baselineRevision }),
            },
          })
        : await api.post<Doc | null>(`/${collection.slug}`, {
            query: { locale },
            body: { data: strip(draft) },
          });

      if (document === null) {
        // 204 with `x-heyo-cms-stopped`: a `before` hook refused it. Not an
        // error, and not a save either — saying "saved" would be a lie.
        toast.info("A hook stopped this write.");
        return false;
      }

      toast.success(id ? "Saved." : "Created.");
      setDirty(new Set());
      if (id) await loaded.reload();
      // `force`: the draft is in the database now, but `dirty` has not
      // re-rendered yet, so the unsaved-changes guard would ask whether to
      // discard work that was just saved.
      else {
        navigate(`/c/${collection.slug}/${String(document.id)}`, {
          force: true,
        });
      }
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "revision_conflict") {
        // Not an error to retry blindly: somebody — another editor, a
        // scheduled change, the assistant — wrote while this form was open,
        // and the honest options are "look at theirs" or "keep mine". By the
        // code, not the 409: a slug or a unique value somebody else already
        // has is a 409 as well, and reloading would not fix that.
        setConflict(true);
      }
      // A refused save — a failed validation, a 403, a 409 — is a toast and
      // nothing else. The same note repeated in the fields pane pushed
      // the fields down the moment they were the thing you needed to fix,
      // and it stayed on screen long after the sentence had been read.
      toast.error(cause);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Takes the server's copy, losing the local draft. The explicit way out. */
  const reloadFromServer = async () => {
    setDirty(new Set());
    setConflict(false);
    await loaded.reload();
    toast.info("Reloaded. Your unsaved changes were discarded.");
  };

  useHotkey("s", () => void save(), { meta: true, enabled: savable });

  const remove = async () => {
    const trashing = config.trash.enabled;
    await confirm({
      title: trashing
        ? "Move this document to the trash?"
        : "Delete this document?",
      description: trashing
        ? config.trash.purgeAfter
          ? `It stops appearing in lists and the API. The purge sweep removes it ${config.trash.purgeAfter} from now.`
          : "It stops appearing in lists and the API, and can be restored from the trash."
        : "This deployment has no trash, so the row is removed now.",
      consequences: [documentTitle(collection, draft)],
      confirmLabel: trashing ? "Move to trash" : "Delete",
      destructive: true,
      run: async () => {
        await api.delete(`/${collection.slug}/${id}`);
        toast.success(trashing ? "Moved to the trash." : "Deleted.");
        setDirty(new Set());
        // Nothing to save it to any more: the guard must not offer to keep
        // editing a document that is in the trash.
        navigate(`/c/${collection.slug}`, { force: true });
      },
    });
  };

  const restore = async () => {
    try {
      await api.post(`/${collection.slug}/${id}/restore`);
      toast.success("Restored.");
      await loaded.reload();
    } catch (cause) {
      toast.error(cause);
    }
  };

  /** The day and the time as one instant, or `null` while it is half-picked. */
  const scheduleAt = useMemo(
    () => atTime(scheduleDay, scheduleTime),
    [scheduleDay, scheduleTime],
  );

  /**
   * Opening the dialog picks a sensible appointment rather than an empty
   * one: tomorrow morning, which is what "schedule this" nearly always
   * means and which the calendar can then show as a selected day.
   */
  const openSchedule = () => {
    const tomorrow = startOfDay(new Date());
    tomorrow.setDate(tomorrow.getDate() + 1);
    setScheduleDay(tomorrow);
    setScheduleTime("09:00");
    setScheduling(true);
  };

  const schedule = async () => {
    try {
      if (!scheduleAt) {
        toast.error(new Error("Pick a day and a time first."));
        return;
      }
      await api.post(`/${collection.slug}/${id}/schedule`, {
        query: { locale },
        body: { at: scheduleAt.toISOString(), data: patch },
      });
      toast.success(
        `Scheduled for ${formatDateTime(scheduleAt.toISOString())}.`,
      );
      setScheduling(false);
      setDirty(new Set());
      await loaded.reload();
    } catch (cause) {
      toast.error(cause);
    }
  };

  const unschedule = async () => {
    await confirm({
      title: "Cancel the scheduled change?",
      description:
        "The patch waiting for its appointed hour is dropped. The document keeps the values it has now.",
      confirmLabel: "Cancel the schedule",
      destructive: true,
      run: async () => {
        await api.delete(`/${collection.slug}/${id}/schedule`);
        toast.success("Scheduled change cancelled.");
        await loaded.reload();
      },
    });
  };

  // A breadcrumb identifies a route, not a mutable document field. A new
  // record is simply "New"; an existing one is always its stable internal id.
  const crumbs = [
    { label: collection.label, to: `/c/${collection.slug}` },
    {
      label: (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="truncate">{id ?? "New"}</span>
          {dirty.size > 0 ? (
            <Tooltip content={`Unsaved: ${[...dirty].join(", ")}`}>
              <Badge variant="warning" size="sm" dot>
                unsaved
              </Badge>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
  ];

  if (loaded.loading && id) {
    return (
      <Page>
        <PageBar
          crumbs={[
            { label: collection.label, to: `/c/${collection.slug}` },
            { label: "…" },
          ]}
          actions={localized ? variant.switcher : undefined}
          usage={{
            kind: "document",
            name: collection.name,
            slug: collection.slug,
            id: id!,
            label: collection.label,
          }}
        />
        <PageLoader />
      </Page>
    );
  }

  if (loaded.error) {
    const notFound =
      loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <Page>
        <PageBar
          crumbs={crumbs}
          actions={localized ? variant.switcher : undefined}
          usage={{
            kind: "document",
            name: collection.name,
            slug: collection.slug,
            id: id!,
            label: collection.label,
          }}
        />
        <PageBody width="column">
          <ErrorNote error={loaded.error} />
          {notFound ? (
            <Text size="xs" tone="subtle">
              A document the deleting account may not see answers the same way
              as one that never existed — that is deliberate.
            </Text>
          ) : null}
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to={`/c/${collection.slug}`} />}
          >
            Back to {collection.label}
          </Button>
        </PageBody>
      </Page>
    );
  }

  const { richText } = splitFields(collection);

  const conflictNotice = conflict ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-heyo-warning-tint p-2.5">
      <Text size="xs" className="flex-1">
        This document changed since you opened it. Saving now would overwrite
        that change.
      </Text>
      <Button
        size="xs"
        variant="outline"
        onClick={() => void reloadFromServer()}
      >
        Reload theirs
      </Button>
    </div>
  ) : null;

  const status = (
    <>
      {conflict ? (
        <Tooltip content="Somebody else saved this document while you were editing it.">
          <Badge variant="warning" size="sm" dot>
            conflict
          </Badge>
        </Tooltip>
      ) : null}
      {trashed ? (
        <Badge variant="danger" size="sm">
          in the trash
        </Badge>
      ) : null}
      {scheduled && !trashed ? (
        <Tooltip content={`Scheduled for ${formatDateTime(scheduled)}`}>
          <Badge variant="info" size="sm" dot>
            scheduled
          </Badge>
        </Tooltip>
      ) : null}
    </>
  );

  const actions = (
    <>
      {id ? (
        <Dropdown>
          <Dropdown.Trigger
            render={
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                icon={IconDots}
                aria-label="Document actions"
              />
            }
          />
          <Dropdown.Content align="end" className="w-56">
            <Dropdown.Group>
              <Dropdown.Label>{collection.label}</Dropdown.Label>
              {canWrite ? (
                <Dropdown.Item icon={IconCalendarClock} onClick={openSchedule}>
                  Schedule this change…
                </Dropdown.Item>
              ) : null}
              {trashed ? (
                <Dropdown.Item
                  icon={IconRotateClockwise}
                  onClick={() => void restore()}
                >
                  Restore
                </Dropdown.Item>
              ) : null}
            </Dropdown.Group>
            {collection.can.delete && !trashed ? (
              <>
                <Dropdown.Separator />
                <Dropdown.Item
                  destructive
                  icon={IconTrash}
                  onClick={() => void remove()}
                >
                  {config.trash.enabled ? "Move to trash…" : "Delete…"}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown>
      ) : null}

      {localized ? variant.switcher : null}

      <Tooltip
        content={
          <Kbd.Group>
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
          </Kbd.Group>
        }
      >
        <Button
          variant="primary"
          size="sm"
          icon={IconDeviceFloppy}
          loading={saving}
          disabled={!savable}
          onClick={() => void save()}
        >
          Save
        </Button>
      </Tooltip>
    </>
  );

  const notices = (
    <>
      {conflictNotice}

      {trashed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-heyo-danger-tint px-3 py-2 ring-1 ring-heyo-danger/25">
          <Text size="xs" className="text-heyo-danger">
            In the trash since {formatDateTime(draft.deletedAt as string)}.
            {draft.purgeAfter
              ? ` It will be removed ${formatRelative(draft.purgeAfter as string)}.`
              : ""}
          </Text>
          <Button size="xs" variant="outline" onClick={() => void restore()}>
            Restore
          </Button>
        </div>
      ) : null}

      {scheduled ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-heyo-warning-tint px-3 py-2 ring-1 ring-heyo-warning/25">
          <Text size="xs" className="text-heyo-warning">
            A change is scheduled for {formatDateTime(scheduled)} (
            {formatRelative(scheduled)}). It carries the permissions of whoever
            scheduled it.
          </Text>
          <Button size="xs" variant="ghost" onClick={() => void unschedule()}>
            Cancel it
          </Button>
        </div>
      ) : null}
    </>
  );

  const scheduleDialog = (
    <Dialog open={scheduling} onOpenChange={setScheduling}>
      {/* `lg`: a month grid is 14rem of fixed cells and the time field needs
          a readable column beside it. At the default width the two wrap, and
          a calendar with a stray input under it reads as two questions. */}
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>Schedule this change</Dialog.Title>
          <Dialog.Description>
            The unsaved fields become a patch applied at the time you pick.
            Access and validation are checked now.
          </Dialog.Description>
        </Dialog.Header>
        {/*
         * A month, not a `datetime-local`.
         *
         * The native control is three spin boxes in an order that changes by
         * platform and by locale, and the question being asked here is "which
         * day" — which is a calendar. heyo-ui's is the one the rest of the
         * panel would use for any other date, so it is the one used here; the
         * time beside it is the only part a grid cannot express.
         */}
        <Dialog.Body className="space-y-3">
          <div className="flex flex-wrap items-start gap-4">
            <Calendar
              value={scheduleDay}
              onSelect={setScheduleDay}
              // Nothing in the past: a scheduled change whose hour has been
              // and gone is a change that never runs.
              min={startOfDay(new Date())}
              aria-label="Day to apply the change"
            />
            <div className="min-w-40 flex-1 space-y-3">
              <Input
                type="time"
                label="Time"
                value={scheduleTime}
                onChange={(event) => setScheduleTime(event.target.value)}
                description="Your own time zone."
              />
              <Text size="xs" tone="subtle">
                {dirty.size === 0
                  ? "Change something first — a schedule with an empty patch would do nothing at the appointed hour."
                  : `Will write: ${[...dirty].join(", ")}.`}
              </Text>
            </div>
          </div>

          {/* The one sentence that says what was actually picked, in the
              panel's own date format rather than the control's. */}
          <Text size="xs" className="text-heyo-strong">
            {scheduleAt
              ? `${formatDateTime(scheduleAt.toISOString())} · ${formatRelative(scheduleAt.toISOString())}`
              : "Pick a day and a time."}
          </Text>
        </Dialog.Body>
        <Dialog.Footer>
          <Button variant="ghost" onClick={() => setScheduling(false)}>
            Cancel
          </Button>
          <Button
            disabled={dirty.size === 0 || !scheduleAt}
            onClick={() => void schedule()}
          >
            Schedule {dirty.size} field{dirty.size === 1 ? "" : "s"}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );

  // ---------------------------------------------------------------------
  // One column, when there is no body to give a column to.
  // ---------------------------------------------------------------------
  if (richText.length === 0) {
    return (
      <Page>
        <PageBar
          crumbs={crumbs}
          status={status}
          actions={actions}
          locale={false}
          usage={
            id
              ? {
                  kind: "document",
                  name: collection.name,
                  slug: collection.slug,
                  id,
                  label: collection.label,
                }
              : {
                  kind: "new",
                  name: collection.name,
                  slug: collection.slug,
                  label: collection.label,
                }
          }
        />
        <PageBody width="column">
          {notices}
          <DocumentForm
            collection={collection}
            {...(id ? { documentId: id } : {})}
            value={draft}
            onChange={change}
            {...(fallback ? { fallback } : {})}
            disabled={!canWrite}
          />
          {id ? (
            <div className="border-t border-heyo-hairline pt-3">
              <Meta draft={draft} id={id} />
            </div>
          ) : null}
        </PageBody>
        {scheduleDialog}
        {variant.dialog}
      </Page>
    );
  }

  return (
    <Page>
      <PageBar
        crumbs={crumbs}
        status={status}
        actions={actions}
        locale={false}
        usage={
          id
            ? {
                kind: "document",
                name: collection.name,
                slug: collection.slug,
                id,
                label: collection.label,
              }
            : {
                kind: "new",
                name: collection.name,
                slug: collection.slug,
                label: collection.label,
              }
        }
      />
      <DocumentEditorLayout
        // A route can switch records without unmounting DocumentEdit. The
        // fields pane is document-local, so mounting it for the new route
        // also applies its assistant-open initial state.
        key={id ?? "new"}
        collection={collection}
        {...(id ? { documentId: id } : {})}
        document={draft}
        onChange={change}
        {...(fallback ? { fallback } : {})}
        disabled={!canWrite}
        notices={notices}
        {...(id ? { details: <Meta draft={draft} id={id} /> } : {})}
      />
      {scheduleDialog}
      {variant.dialog}
    </Page>
  );
}

/** Identity and timestamps: the three facts the form cannot show. */
function Meta({ draft, id }: { draft: Doc; id: string }) {
  return (
    <div className="space-y-1">
      <Row label="ID" value={String(draft.id ?? id)} mono />
      <Row label="Updated" value={formatRelative(draft.updatedAt as string)} />
      <Row label="Created" value={formatRelative(draft.createdAt as string)} />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <Text size="xs" tone="subtle" as="span">
        {label}
      </Text>
      <Text size="xs" as="span" mono={mono} truncate>
        {value}
      </Text>
    </div>
  );
}

/**
 * A day from the calendar and an `HH:MM` from the time field, as one local
 * instant. `null` until both are answered — a half-picked appointment is not
 * a time, and guessing midnight for it would schedule the wrong hour.
 */
function atTime(day: Date | null, time: string): Date | null {
  if (!day) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(day);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

/** A new document starts at the configuration's defaults, not at empty. */
function defaults(collection: PanelCollection): Doc {
  const document: Doc = {};
  for (const field of collection.fields) {
    if (field.defaultValue !== undefined) {
      document[field.name] = field.defaultValue;
    }
  }
  return document;
}

/** System columns are the engine's; sending them back would be nonsense. */
function strip(document: Doc): Doc {
  const system = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "updatedBy",
    "deletedAt",
    "purgeAfter",
    "scheduledAt",
    "scheduledPatch",
    "_fallback",
    "_localeFields",
  ]);
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !system.has(key)),
  );
}
