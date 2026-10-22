import type { PanelCollection } from "@heyo-sh/heyo-cms/types";
import { Badge, Button, Kbd, Text, Tooltip } from "@heyo-sh/heyo-ui";
import { IconDeviceFloppy, IconLock } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../lib/api";
import { useAssistant } from "../lib/assistant";
import { useAsync, useHotkey, useUnsavedWarning } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { usePageContext } from "../components/ai-assistant";
import { useConfirm } from "../components/confirm";
import { useNavigationBlock } from "../lib/router";
import { toast } from "../lib/toast";
import { sameValue } from "../lib/value";
import { ErrorNote } from "../components/chrome";
import { DocumentForm, splitFields } from "../components/document-form";
import { DocumentEditorLayout } from "../components/document-editor-layout";
import { useLocaleVariant } from "../components/locale-variant";
import { Page, PageBar, PageBody, PageLoader } from "../components/page";

type Doc = Record<string, unknown>;

/**
 * A global: the same form, one row, no list.
 *
 * It shares the same form and writing layout as a collection, which reflects
 * the engine — a global is the same table, hooks and events, minus `find` and
 * `create`. The visible differences are real: there is nothing to delete, and
 * an unsaved global reads as its defaults rather than as a 404.
 */
export function GlobalEdit({ global }: { global: PanelCollection }) {
  const { locale } = usePanel();
  const confirm = useConfirm();
  // Site settings carries the panel-wide language context even when the
  // current schema has no localized field yet.
  const showLocale =
    global.slug === "settings" ||
    global.fields.some((field) => field.localized);
  const [draft, setDraft] = useState<Doc>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const variant = useLocaleVariant({
    collection: global,
    dirty: dirty.size > 0,
    confirmDiscard: () =>
      confirm({
        title: "Save before switching languages?",
        description:
          "Save your current edits before opening or creating another language version.",
        confirmLabel: "Save and continue",
        cancelLabel: "Keep editing",
        run: async () => {
          if (!(await save()))
            throw new Error(
              "The global could not be saved. Your draft is still here.",
            );
        },
      }),
  });

  const loaded = useAsync<Doc>(
    (signal) =>
      api.get<Doc>(`/globals/${global.slug}`, {
        signal,
        query: { locale, depth: 0 },
      }),
    [global.slug, locale],
  );

  /** The stored global, which every "has this changed?" is asked against. */
  const baseline = useMemo(() => loaded.data ?? {}, [loaded.data]);

  useEffect(() => {
    setDraft(baseline);
    setDirty(new Set());
    setConflict(false);
  }, [baseline]);

  const baselineRevision =
    typeof loaded.data?.revision === "number" ? loaded.data.revision : null;

  usePageContext({
    kind: "global",
    collectionSlug: global.slug,
    ...(dirty.size > 0 ? { dirtyFields: [...dirty] } : {}),
    ...(baselineRevision === null ? {} : { baselineRevision }),
  });

  const { onMutation } = useAssistant();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    return onMutation((notice) => {
      if (notice.target.kind !== "global") return;
      if (notice.target.collectionSlug !== global.slug) return;
      if (dirtyRef.current.size > 0) {
        setConflict(true);
        toast.info("The assistant changed this global while you were editing.");
        return;
      }
      void loaded.reload();
    });
  }, [global.slug, loaded, onMutation]);

  useUnsavedWarning(dirty.size > 0);

  useNavigationBlock(dirty.size > 0, () =>
    confirm({
      title: "Leave without saving?",
      description: `${dirty.size} field${dirty.size === 1 ? "" : "s"} changed since the last save.`,
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    }),
  );

  const patch = useMemo(() => {
    const result: Doc = {};
    for (const name of dirty) result[name] = draft[name] ?? null;
    return result;
  }, [dirty, draft]);

  // Dirty is a comparison with the stored value, not a record of which
  // controls have spoken: see `change` in `screens/document-edit`, which this
  // is the same form of.
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

  const save = async (): Promise<boolean> => {
    if (!global.can.update || saving || dirty.size === 0) return false;
    setSaving(true);
    try {
      const updated = await api.patch<Doc | null>(`/globals/${global.slug}`, {
        query: { locale },
        body: {
          data: patch,
          ...(baselineRevision === null ? {} : { revision: baselineRevision }),
        },
      });
      if (updated === null) {
        toast.info("A hook stopped this write.");
        return false;
      }
      toast.success("Saved.");
      setDirty(new Set());
      await loaded.reload();
      return true;
    } catch (cause) {
      // A refused save is a toast and nothing else: the pane beside the
      // writing is for the document's properties, not for a message about
      // the last attempt to store them.
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
      toast.error(cause);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const reloadFromServer = async () => {
    setDirty(new Set());
    setConflict(false);
    await loaded.reload();
    toast.info("Reloaded. Your unsaved changes were discarded.");
  };

  const savable = global.can.update && !saving && dirty.size > 0;
  useHotkey("s", () => void save(), { meta: true, enabled: savable });

  if (loaded.loading && !loaded.data) {
    return (
      <Page>
        <PageBar
          crumbs={[{ label: global.label }]}
          actions={showLocale ? variant.switcher : undefined}
          usage={{
            kind: "global",
            name: global.name,
            slug: global.slug,
            label: global.label,
          }}
        />
        <PageLoader />
      </Page>
    );
  }

  const fallback = (loaded.data?._fallback ?? undefined) as
    Record<string, string> | undefined;

  const { richText } = splitFields(global);
  const bar = (
    <PageBar
      crumbs={[{ label: global.label }]}
      usage={{
        kind: "global",
        name: global.name,
        slug: global.slug,
        label: global.label,
      }}
      status={
        <>
          {conflict ? (
            <Tooltip content="This global changed since you opened it.">
              <Badge variant="warning" size="sm" dot>
                conflict
              </Badge>
            </Tooltip>
          ) : null}
          {dirty.size > 0 ? (
            <Tooltip content={`Unsaved: ${[...dirty].join(", ")}`}>
              <Badge variant="warning" size="sm" dot>
                unsaved
              </Badge>
            </Tooltip>
          ) : null}
          {global.can.update ? null : (
            <Tooltip content="Your account may read this global but not write it. Every field is disabled.">
              <Badge variant="outline" size="sm" icon={IconLock}>
                read-only
              </Badge>
            </Tooltip>
          )}
        </>
      }
      actions={
        <>
          {showLocale ? variant.switcher : null}
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
      }
    />
  );

  const conflictNotice = conflict ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-heyo-warning-tint p-2.5">
      <Text size="xs" className="flex-1">
        This global changed since you opened it. Saving now would overwrite that
        change.
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

  if (richText.length > 0) {
    return (
      <Page>
        {bar}
        {variant.dialog}
        <DocumentEditorLayout
          collection={global}
          document={draft}
          onChange={change}
          {...(fallback ? { fallback } : {})}
          disabled={!global.can.update}
          notices={
            <>
              {conflictNotice}
              <ErrorNote error={loaded.error} />
            </>
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      {bar}
      {variant.dialog}
      <PageBody width="column">
        {conflictNotice}
        <ErrorNote error={loaded.error} />
        <DocumentForm
          collection={global}
          value={draft}
          onChange={change}
          {...(fallback ? { fallback } : {})}
          disabled={!global.can.update}
        />
      </PageBody>
    </Page>
  );
}
