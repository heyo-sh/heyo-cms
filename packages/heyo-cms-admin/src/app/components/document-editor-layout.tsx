import type { PanelCollection, PanelField } from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  ScrollArea,
  Tabs,
  Text,
  Tooltip,
  cn,
} from "@heyo-sh/heyo-ui";
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import { useAssistantPane } from "../lib/assistant-pane";
import { usePanel } from "../lib/panel";
import { usePageTab } from "./ai-assistant";
import { FieldActions } from "./field-actions";
import { DocumentFields, splitFields } from "./document-form";
import { PageStrip } from "./page";
import { RichTextEditor } from "./rich-text/editor";

/**
 * The writing layout shared by documents and globals.
 *
 * Every rich-text field belongs to the writing pane, irrespective of its
 * configured form position. Everything else is a field of the record, so it
 * stays in the right-hand pane while switching editor tabs never changes the
 * fields in view.
 *
 * There is no chat in here any more. The old dock lived at the foot of the
 * writing column, which tied the one conversational surface in the panel to
 * the existence of a rich-text field: no chat on a list, on media, on
 * settings, or on a collection written entirely in plain fields. The
 * assistant is in `Shell` now, and the per-field `AiMenu` — one deterministic
 * action on one field — stays exactly where it was.
 *
 * The fields pane is a sidebar of its own: one width, one layout, and a
 * trigger in its own header strip that collapses it to a rail. It used to
 * squeeze itself to a half-width variant while the assistant drawer was open,
 * which meant two sets of paddings and two field layouts for one pane, and a
 * pane too narrow to edit in either way. Collapsing is the honest version of
 * the same thought: the drawer takes 24rem off the right of the window, so
 * opening it folds the pane away — and the trigger is right there to bring it
 * back when the fields are what you came for.
 */
export function DocumentEditorLayout({
  collection,
  documentId,
  document,
  onChange,
  fallback,
  disabled,
  notices,
  details,
}: {
  collection: PanelCollection;
  documentId?: string;
  document: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  fallback?: Record<string, string>;
  disabled: boolean;
  notices?: ReactNode;
  details?: ReactNode;
}) {
  const { richText, main } = splitFields(collection);
  // A document reached while AI is already open starts folded. The shared
  // transition keeps the pane and the drawer moving in the same frame.
  const { open, setOpen } = useAssistantPane();
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const field =
    richText.find((entry) => entry.name === selectedName) ?? richText[0];

  // Which writing surface is in front. A record with two rich-text fields is
  // a tab strip, and "rewrite this section" names whichever one the editor is
  // looking at — a question the assistant could not answer while this was
  // local state. The field's own name, not its label: the agent patches
  // fields by name, and a label is a translation of one.
  usePageTab(field?.name ?? null);

  if (!field) return null;

  const fields = main;
  const editor = (
    <EditorPane
      key={field.name}
      field={field}
      collection={collection}
      documentId={documentId}
      document={document}
      onChange={onChange}
      disabled={disabled}
      {...(fallback?.[field.name]
        ? { fallbackFrom: fallback[field.name] }
        : {})}
    />
  );

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-h-0 min-w-0 flex-col lg:border-r lg:border-heyo-hairline">
        {richText.length > 1 ? (
          <Tabs
            variant="segmented"
            value={field.name}
            onValueChange={(value) => setSelectedName(String(value))}
            className="min-h-0 flex-1 gap-0"
          >
            <PageStrip>
              <Tabs.List
                items={richText.map((entry) => ({
                  value: entry.name,
                  label: entry.label,
                }))}
              />
            </PageStrip>
            <Tabs.Panel
              value={field.name}
              className="flex min-h-0 flex-1 flex-col"
            >
              {editor}
            </Tabs.Panel>
          </Tabs>
        ) : (
          editor
        )}
      </div>

      {/*
       * Collapsing is a width on the pane, not a column on the grid and not a
       * conditional render, which is how the app's own sidebar does it and
       * for the same two reasons. Unmounting the fields meant they came back
       * at whatever width the pane had at that instant — a rail — so every
       * expansion started with a frame of text wrapped into a 3rem column
       * before it snapped out. And the contents keep their full width the
       * whole way through: the pane clips them rather than reflowing them,
       * so nothing re-wraps mid-animation. Same duration and easing as the
       * sidebar, from the same variable, so the two folds are one gesture.
       */}
      <aside
        aria-label="Document fields"
        data-state={open ? "expanded" : "collapsed"}
        className={cn(
          "group/fields flex min-h-0 w-full flex-col overflow-hidden bg-heyo-base",
          "[--fields-width:20rem] xl:[--fields-width:24rem]",
          "lg:h-full lg:w-(--fields-width)",
          "lg:transition-[width] lg:duration-(--heyo-sidebar-duration) lg:ease-heyo",
          "lg:data-[state=collapsed]:w-(--heyo-sidebar-width-icon)",
          "motion-reduce:transition-none",
        )}
      >
        {/*
         * The pane's own bar is just a touch taller than the page strips, to
         * match the sidebar's search-and-assistant controls. Its bottom rule
         * continues the chrome across the editor and fields panes.
         */}
        {/*
         * `px-2.5` around a 2rem control is also what centres the trigger in
         * the folded rail: 10px + 32px + 10px is the 3.25rem the rail is, to
         * the pixel, and it is the padding every row in the app's sidebar
         * uses. The control is `base` for the same reason — a 16px glyph,
         * like `Sidebar.Trigger` in the bar above it, rather than the 14px
         * the editor toolbar uses for its twenty buttons.
         */}
        <div className="flex h-[3.125rem] w-full shrink-0 items-center gap-1.5 border-b border-heyo-hairline px-2.5">
          <Tooltip content={open ? "Hide fields" : "Show fields"}>
            <Button
              size="base"
              shape="square"
              variant="ghost"
              icon={
                open
                  ? IconLayoutSidebarRightCollapse
                  : IconLayoutSidebarRightExpand
              }
              aria-label={open ? "Hide fields" : "Show fields"}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            />
          </Tooltip>
          {/* The pane's only heading, now that the fields below are not
              wrapped in a disclosure that repeated it. `sm` and the default
              tone are what every other label in the panel's chrome is: the
              strip names the pane, it is not a caption under it.

              Faded rather than removed: a word that disappears at the start
              of the fold does not take a layout step with it. */}
          <Text
            size="sm"
            className={cn(
              "min-w-0 truncate transition-opacity duration-(--heyo-sidebar-duration) ease-heyo",
              "group-data-[state=collapsed]/fields:opacity-0",
            )}
          >
            Fields
          </Text>
        </div>

        {/*
         * Folded, the fields keep their full width and the pane clips them,
         * which is what makes the animation reflow-free — but clipping a
         * 20rem column into a 3.25rem rail leaves its left edge showing, and
         * the left edge of a field list is a column of labels. So the
         * contents also fade, and end `invisible`: a rail shows the trigger
         * and nothing else. `visibility` transitions discretely and in our
         * favour both ways — it stays visible for the whole fold, and it is
         * back the instant the pane starts opening, so nothing pops in late.
         *
         * `inert` goes with it: out of sight is out of the tab order.
         */}
        <ScrollArea
          {...(open ? {} : { inert: true })}
          className={cn(
            "min-h-0 w-full flex-1 lg:w-(--fields-width)",
            "transition-[opacity,visibility] duration-(--heyo-sidebar-duration) ease-heyo",
            "motion-reduce:transition-none",
            // No animation to preserve on a stacked, full-width pane — and a
            // rail with 20rem of fields clipped under it would be nonsense.
            !open && "invisible opacity-0 max-lg:hidden",
          )}
        >
          {notices ? (
            <div className="space-y-2 px-4 pt-4 empty:hidden">{notices}</div>
          ) : null}
          {/*
           * The fields, flat.
           *
           * They used to sit in a single-item accordion, which is a
           * disclosure with nothing to disclose: there is no second section
           * to collapse these in favour of, the pane already folds as a
           * whole from the strip above, and the trigger spent a row of the
           * pane repeating the word written two lines higher. What is left
           * is the content it held, at the padding it held it with.
           */}
          <div className="px-4 pt-4 pb-5">
            {fields.length > 0 ? (
              <div className="space-y-4">
                <DocumentFields
                  fields={fields}
                  collection={collection}
                  {...(documentId ? { documentId } : {})}
                  value={document}
                  onChange={onChange}
                  {...(fallback ? { fallback } : {})}
                  disabled={disabled}
                  horizontal
                />
              </div>
            ) : (
              <Text size="sm" tone="subtle">
                This entry has no additional fields.
              </Text>
            )}
          </div>
          {details ? <div className="px-4 py-4">{details}</div> : null}
        </ScrollArea>
      </aside>
    </div>
  );
}

function EditorPane({
  field,
  collection,
  documentId,
  document,
  onChange,
  disabled,
  fallbackFrom,
}: {
  field: PanelField;
  collection: PanelCollection;
  documentId?: string;
  document: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  disabled: boolean;
  fallbackFrom?: string;
}) {
  const { locale } = usePanel();
  const readOnly = disabled || !field.access.update;
  const nodes = Array.isArray(field.options.nodes)
    ? (field.options.nodes as string[])
    : undefined;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto heyo-scrollbar">
        <RichTextEditor
          value={document[field.name] as Record<string, unknown> | null}
          onChange={(next) => onChange(field.name, next)}
          disabled={readOnly}
          variant="page"
          {...(nodes ? { nodes } : {})}
          {...(field.admin.placeholder === undefined
            ? {}
            : { placeholder: field.admin.placeholder })}
          toolbarExtra={
            <div className="flex items-center gap-1.5">
              {field.localized && fallbackFrom ? (
                <Tooltip
                  content={`No value in the current language yet; showing ${fallbackFrom}`}
                >
                  <Badge variant="warning" size="sm">
                    from {fallbackFrom}
                  </Badge>
                </Tooltip>
              ) : null}
              <FieldActions
                field={field}
                collection={
                  collection.kind === "global"
                    ? `globals/${collection.slug}`
                    : collection.slug
                }
                {...(documentId ? { documentId } : {})}
                document={document}
                locale={locale}
                disabled={readOnly}
                onInsert={(next) => onChange(field.name, next)}
              />
            </div>
          }
        />
      </div>
    </>
  );
}
