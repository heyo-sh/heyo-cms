import type { PanelCollection, PanelField } from "@heyo-sh/heyo-cms/types";
import { Badge, Label, Text, Tooltip, cn } from "@heyo-sh/heyo-ui";
import { IconLanguage, IconLock } from "@tabler/icons-react";
import { useId } from "react";

import { usePanel } from "../lib/panel";
import { FieldActions } from "./field-actions";
import { FieldInput } from "./field-input";

/**
 * The form, generated from the collection's fields.
 *
 * Nothing in this file knows about any particular collection, and that is the
 * point: the panel has no per-project code, so a field added to the
 * configuration appears here on the next page load. What it does know is the
 * four things that decide how a field is presented, all of which arrive in
 * `PanelField`:
 *
 * - **Field-level access.** A field the actor may not read is not rendered —
 *   it is also absent from the document, because the engine removed it — and
 *   one they may not write is rendered disabled rather than hidden, so they
 *   can see the value that is there. That is the whole of "who may publish":
 *   `status` is a select like any other, disabled for a writer and enabled
 *   for an editor.
 * - **Localization.** A localized field carries a glyph, and when the value
 *   was answered from the default language instead (`_fallback`) a badge says
 *   which one it came from. Which language is being
 *   edited is not repeated here: the switcher in the navigation row is the
 *   single place that answers that, and it is the place you can change it.
 * - **Generation.** Separate deterministic and AI actions sit beside the field.
 */

export interface DocumentFormProps {
  collection: PanelCollection;
  /** The stored document, when it has been saved. Drives the AI route. */
  documentId?: string | undefined;
  value: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  /** Which fields were answered from another locale, and from which. */
  fallback?: Record<string, string>;
  /** Field name to message, as the server reported them. */
  errors?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Rich text is the writing surface, not a form control among other controls.
 * Every visible rich-text field therefore goes to the editor pane; all other
 * fields stay available as document properties. This makes a second body a
 * tab, rather than a rich-text input accidentally appearing in the sidebar.
 */
export function splitFields(collection: PanelCollection): {
  richText: PanelField[];
  main: PanelField[];
} {
  const visible = collection.fields.filter(
    (field) => !field.admin.hidden && field.access.read,
  );
  const richText = visible.filter((field) => field.type === "richText");
  const other = visible.filter((field) => field.type !== "richText");
  return { richText, main: other };
}

export function DocumentForm({
  collection,
  documentId,
  value,
  onChange,
  fallback,
  errors,
  disabled,
}: DocumentFormProps) {
  const { main } = splitFields(collection);

  // Without a writing pane, a second column only separates ordinary form
  // controls from one another. Keep the entire form in one readable stack.
  return (
    <div className="space-y-4">
      <DocumentFields
        fields={main}
        collection={collection}
        documentId={documentId}
        value={value}
        onChange={onChange}
        {...(fallback ? { fallback } : {})}
        {...(errors ? { errors } : {})}
        disabled={disabled === true}
        stacked
      />
    </div>
  );
}

/** A run of fields, with no opinion about the box they sit in. */
export function DocumentFields({
  fields,
  collection,
  documentId,
  value,
  onChange,
  fallback,
  errors,
  disabled,
  stacked,
  horizontal,
}: Omit<DocumentFormProps, "disabled"> & {
  fields: PanelField[];
  disabled: boolean;
  stacked?: boolean;
  /** Compact property panes pair the field label with its control. */
  horizontal?: boolean;
}) {
  return (
    <>
      {fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          collection={collection}
          documentId={documentId}
          document={value}
          onChange={onChange}
          {...(fallback?.[field.name]
            ? { fallbackFrom: fallback[field.name] as string }
            : {})}
          {...(errors?.[field.name]
            ? { error: errors[field.name] as string }
            : {})}
          disabled={disabled}
          {...(stacked ? { stacked: true } : {})}
          {...(horizontal ? { horizontal: true } : {})}
        />
      ))}
    </>
  );
}

/**
 * Where the AI routes for this document live.
 *
 * A global is mounted under `/globals/<slug>` and has no id, so the same
 * component addresses both without knowing which it is looking at.
 */
function aiPrefix(collection: PanelCollection): string {
  return collection.kind === "global"
    ? `globals/${collection.slug}`
    : collection.slug;
}

export function FieldRow({
  field,
  collection,
  documentId,
  document,
  onChange,
  fallbackFrom,
  error,
  disabled,
  stacked,
  horizontal,
}: {
  field: PanelField;
  collection: PanelCollection;
  documentId?: string | undefined;
  document: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  fallbackFrom?: string;
  error?: string;
  disabled: boolean;
  stacked?: boolean;
  horizontal?: boolean;
}) {
  const { locale } = usePanel();
  const id = useId();
  const readOnly = disabled || !field.access.update;

  return (
    <div
      className={cn("w-full", horizontal && "flex min-w-0 items-start gap-3")}
    >
      <div
        className={cn(
          "mb-1.5 flex min-h-6 items-center gap-1.5",
          horizontal && "mb-0 min-h-8 w-24 shrink-0",
        )}
      >
        {/*
         * Required is marked, optional is not.
         *
         * heyo-ui's `optional` tag is right on a form where most fields are
         * required. A CMS collection is the other way round — three fields
         * matter and eleven are optional — so the tag appeared on nearly
         * every row and said nothing. The asterisk carries it instead.
         */}
        {/*
         * The label is the quietest thing in the row: the value is what the
         * editor is reading, and a column of bold names down the left of a
         * property pane competes with it. Muted, like every other piece of
         * chrome that names something rather than being it.
         */}
        <Label htmlFor={id} className="min-w-0 truncate text-heyo-subtle">
          {field.label}
          {field.required ? (
            <span
              aria-hidden
              title="Required"
              className="ml-0.5 text-heyo-danger"
            >
              *
            </span>
          ) : null}
        </Label>

        {field.localized ? (
          fallbackFrom ? (
            // The one language fact worth a badge: this value is not in the
            // language you are editing, and the switcher cannot tell you so.
            <Tooltip
              content={`No value in the current language yet — showing the ${fallbackFrom} one`}
            >
              <Badge variant="warning" size="sm" icon={IconLanguage}>
                from {fallbackFrom}
              </Badge>
            </Tooltip>
          ) : (
            <Tooltip content="Translated per language">
              <span className="inline-flex shrink-0 items-center text-heyo-inactive">
                <IconLanguage className="size-3.5" />
              </span>
            </Tooltip>
          )
        ) : null}

        {!field.access.update ? (
          <Tooltip
            content={
              field.readOnly
                ? "Declared read-only."
                : "Your account may read this field but not write it."
            }
          >
            <Badge variant="outline" size="sm" icon={IconLock}>
              read-only
            </Badge>
          </Tooltip>
        ) : null}

        <span className="flex-1" />
      </div>

      <div className={cn(horizontal && "min-w-0 flex-1")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <FieldInput
              id={id}
              field={field}
              value={document[field.name]}
              document={document}
              disabled={readOnly}
              collection={aiPrefix(collection)}
              {...(documentId ? { documentId } : {})}
              locale={locale}
              onChange={(next) => onChange(field.name, next)}
            />
          </div>
          <FieldActions
            field={field}
            collection={aiPrefix(collection)}
            {...(documentId ? { documentId } : {})}
            document={document}
            locale={locale}
            disabled={readOnly}
            onInsert={(next) => onChange(field.name, next)}
          />
        </div>

        {field.description ? (
          <Text size="xs" tone="subtle" className="mt-1">
            {field.description}
          </Text>
        ) : null}
        {error ? (
          <Text size="xs" className="mt-1 text-heyo-danger">
            {error}
          </Text>
        ) : null}
      </div>
    </div>
  );
}
