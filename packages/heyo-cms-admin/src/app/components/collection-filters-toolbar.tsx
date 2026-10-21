import {
  Button,
  Combobox,
  DatePicker,
  Input,
  Popover,
  Select,
  Text,
} from "@heyo-sh/heyo-ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  COLLECTION_FILTER_OPERATOR_LABELS,
  collectionFilterBadgeLabel,
  createCollectionFilterFieldMap,
  createNewCollectionFilter,
  getDefaultOperatorForCollectionField,
  isCollectionFilterValueReady,
  type AppliedCollectionFilter,
  type CollectionFilterFieldDefinition,
  type CollectionFilterFieldGroup,
  type CollectionFilterOperator,
  type CollectionFilterValue,
  type DraftCollectionFilter,
} from "../lib/collection-filters";

type FilterEditorState = {
  isNew: boolean;
  draft: DraftCollectionFilter;
};

function AddFilterFieldPicker({
  groups,
  icon,
  disabled,
  onSelect,
}: {
  groups: CollectionFilterFieldGroup[];
  icon: "filter" | "plus";
  disabled: boolean;
  onSelect: (fieldId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            type="button"
            size="sm"
            shape="square"
            variant="outline"
            icon={icon === "filter" ? IconFilter : IconPlus}
            disabled={disabled}
            aria-label="Add filter"
          />
        }
      />
      <Popover.Content
        align="start"
        sideOffset={6}
        className="max-h-[min(20rem,var(--available-height))] w-56 overflow-y-auto p-1 heyo-scrollbar"
      >
        {groups.map((group) =>
          group.fields.length > 0 ? (
            <div
              key={group.label}
              className="not-first:mt-1 not-first:border-t not-first:border-heyo-hairline not-first:pt-1"
            >
              <Text
                size="xs"
                tone="subtle"
                className="block px-2 py-1 font-medium"
              >
                {group.label}
              </Text>
              {group.fields.map((field) => (
                <Button
                  key={field.id}
                  type="button"
                  size="sm"
                  shape="block"
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    onSelect(field.id);
                    setOpen(false);
                  }}
                >
                  {field.label}
                </Button>
              ))}
            </div>
          ) : null,
        )}
      </Popover.Content>
    </Popover>
  );
}

function FilterValueInput({
  field,
  value,
  onChange,
}: {
  field: CollectionFilterFieldDefinition;
  value: CollectionFilterValue | null;
  onChange: (value: CollectionFilterValue | null) => void;
}) {
  if (field.inputKind === "select" || field.inputKind === "multiselect") {
    const selected = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : typeof value === "string" && value.trim().length > 0
        ? [value]
        : [];

    return (
      <Combobox
        multiple
        size="sm"
        options={(field.options ?? []).map((option) => ({
          value: String(option.value),
          label: option.label,
        }))}
        value={selected}
        placeholder="Select values"
        emptyMessage="No values found."
        aria-label={`${field.label} values`}
        className="w-full"
        onValueChange={(next) => onChange(next.length > 0 ? next : null)}
      />
    );
  }

  if (field.inputKind === "boolean") {
    const options = (field.options ?? []).map((option) => ({
      value: String(option.value),
      label: option.label,
    }));
    return (
      <Select
        value={value === null ? null : String(value)}
        onValueChange={(next) => {
          if (next === null) onChange(null);
          else onChange(next === "true");
        }}
      >
        <Select.Trigger
          size="sm"
          placeholder="Select a value"
          aria-label={`${field.label} value`}
          className="w-full"
        />
        <Select.Content items={options} />
      </Select>
    );
  }

  if (field.inputKind === "number") {
    return (
      <Input
        size="sm"
        type="number"
        step={field.integer ? "1" : "any"}
        inputMode={field.integer ? "numeric" : "decimal"}
        value={typeof value === "number" ? String(value) : ""}
        placeholder="Enter a number"
        aria-label={`${field.label} value`}
        onChange={(event) => {
          const next = event.target.value.trim();
          const parsed = Number(next);
          onChange(next !== "" && Number.isFinite(parsed) ? parsed : null);
        }}
      />
    );
  }

  if (field.inputKind === "date" || field.inputKind === "datetime") {
    return <DateFilterInput field={field} value={value} onChange={onChange} />;
  }

  return (
    <Input
      size="sm"
      value={typeof value === "string" ? value : ""}
      placeholder="Enter a value"
      aria-label={`${field.label} value`}
      onChange={(event) => onChange(event.target.value || null)}
    />
  );
}

function DateFilterInput({
  field,
  value,
  onChange,
}: {
  field: CollectionFilterFieldDefinition;
  value: CollectionFilterValue | null;
  onChange: (value: CollectionFilterValue | null) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const date = calendarDate(text);

  return (
    <DatePicker
      size="sm"
      value={date}
      placeholder="Select a date"
      aria-label={`${field.label} value`}
      className="w-full"
      onValueChange={(next) => {
        if (!next) {
          onChange(null);
          return;
        }
        onChange(
          field.inputKind === "datetime"
            ? `${calendarDateValue(next)}T${timeOfDay(text)}`
            : calendarDateValue(next),
        );
      }}
    />
  );
}

function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDateValue(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function timeOfDay(value: string): string {
  return /T(\d{2}:\d{2})/.exec(value)?.[1] ?? "00:00";
}

function FilterEditor({
  field,
  draft,
  onDraftChange,
  onCancel,
  onApply,
}: {
  field: CollectionFilterFieldDefinition;
  draft: DraftCollectionFilter;
  onDraftChange: (draft: DraftCollectionFilter) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <Popover.Content align="start" sideOffset={6} className="w-80 p-2.5">
      <Text size="xs" tone="subtle" className="mb-2 block px-0.5">
        {field.groupLabel} / {field.label}
      </Text>
      <div className="grid gap-2">
        <Select
          value={draft.operator}
          onValueChange={(operator) => {
            if (operator === null) return;
            onDraftChange({
              ...draft,
              operator: operator as CollectionFilterOperator,
            });
          }}
        >
          <Select.Trigger
            size="sm"
            className="w-full"
            aria-label={`${field.label} operator`}
          />
          <Select.Content
            items={field.operators.map((operator) => ({
              value: operator,
              label: COLLECTION_FILTER_OPERATOR_LABELS[operator],
            }))}
          />
        </Select>
        <FilterValueInput
          field={field}
          value={draft.value}
          onChange={(value) => onDraftChange({ ...draft, value })}
        />
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!isCollectionFilterValueReady(field, draft.value)}
          onClick={onApply}
        >
          Apply
        </Button>
      </div>
    </Popover.Content>
  );
}

export interface CollectionFiltersToolbarProps {
  search: string;
  searchEnabled: boolean;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  filterFieldGroups: CollectionFilterFieldGroup[];
  appliedFilters: AppliedCollectionFilter[];
  onFiltersChange: (filters: AppliedCollectionFilter[]) => void;
  /** Stays visible beside the filters, e.g. the existing clear-all action. */
  trailingAction?: React.ReactNode;
}

/**
 * The table's compact query builder.
 *
 * It follows Paragraph's interaction model: select a field, configure an
 * operator and value in a popover, then edit or remove the resulting chip.
 * The scrolling viewport keeps a long query from moving the search control or
 * the table actions off-screen.
 */
export function CollectionFiltersToolbar({
  search,
  searchEnabled,
  searchPlaceholder,
  onSearchChange,
  filterFieldGroups,
  appliedFilters,
  onFiltersChange,
  trailingAction,
}: CollectionFiltersToolbarProps) {
  const [editor, setEditor] = useState<FilterEditorState | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const fieldMap = useMemo(
    () => createCollectionFilterFieldMap(filterFieldGroups),
    [filterFieldGroups],
  );
  const hasAppliedFilters = appliedFilters.length > 0;
  const optionsAvailable = filterFieldGroups.some(
    (group) => group.fields.length > 0,
  );
  const newEditor = editor?.isNew ? editor : null;
  const pendingField = newEditor
    ? (fieldMap.get(newEditor.draft.fieldId) ?? null)
    : null;

  const syncScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    const width = Math.max(viewport.scrollWidth, content.scrollWidth);
    const overflows = width > viewport.clientWidth + 4;
    setCanScrollLeft(overflows && viewport.scrollLeft > 4);
    setCanScrollRight(
      overflows && viewport.scrollLeft + viewport.clientWidth < width - 4,
    );
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    syncScrollState();
    viewport.addEventListener("scroll", syncScrollState, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncScrollState);
    observer?.observe(viewport);
    observer?.observe(content);

    return () => {
      viewport.removeEventListener("scroll", syncScrollState);
      observer?.disconnect();
    };
  }, [syncScrollState]);

  useEffect(() => {
    const frame = requestAnimationFrame(syncScrollState);
    return () => cancelAnimationFrame(frame);
  }, [appliedFilters, editor, syncScrollState]);

  const openNewFilter = (fieldId: string) => {
    const field = fieldMap.get(fieldId);
    if (!field) return;
    setEditor({
      isNew: true,
      draft: {
        ...createNewCollectionFilter(fieldId),
        operator: getDefaultOperatorForCollectionField(field),
      },
    });
  };

  const applyFilter = () => {
    if (!editor) return;
    const field = fieldMap.get(editor.draft.fieldId);
    if (!field || !isCollectionFilterValueReady(field, editor.draft.value)) {
      return;
    }

    const next: AppliedCollectionFilter = {
      ...editor.draft,
      value: editor.draft.value,
    };
    onFiltersChange(
      editor.isNew
        ? [...appliedFilters, next]
        : appliedFilters.map((filter) =>
            filter.id === next.id ? next : filter,
          ),
    );
    setEditor(null);
  };

  const removeFilter = (id: string) => {
    onFiltersChange(appliedFilters.filter((filter) => filter.id !== id));
    if (editor?.draft.id === id) setEditor(null);
  };

  const scrollFilters = (direction: "left" | "right") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left:
        direction === "left"
          ? -Math.max(viewport.clientWidth * 0.75, 180)
          : Math.max(viewport.clientWidth * 0.75, 180),
      behavior: "smooth",
    });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {searchEnabled ? (
        <Input
          size="sm"
          icon={IconSearch}
          value={search}
          className="w-56 shrink-0"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder.replace("…", "")}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      ) : null}

      {!hasAppliedFilters && !newEditor ? (
        <AddFilterFieldPicker
          groups={filterFieldGroups}
          icon="filter"
          disabled={!optionsAvailable}
          onSelect={openNewFilter}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div
            ref={viewportRef}
            className="min-w-0 overflow-x-hidden overflow-y-hidden py-1"
          >
            {/* Each filter has its own outline and one internal divider. */}
            <div
              ref={contentRef}
              className="flex min-w-max items-center gap-2 px-1"
            >
              {appliedFilters.map((filter) => {
                const field = fieldMap.get(filter.fieldId);
                if (!field) return null;
                const open = editor?.draft.id === filter.id;
                const trigger = (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="max-w-64 justify-start rounded-r-none"
                  >
                    <span className="truncate">
                      {collectionFilterBadgeLabel(filter, field)}
                    </span>
                  </Button>
                );

                return (
                  <div
                    key={filter.id}
                    role="group"
                    className="isolate inline-flex items-center rounded-md ring-1 ring-heyo-line [&>*:hover]:z-10 [&>*:focus-visible]:z-10"
                  >
                    <Popover
                      open={open}
                      onOpenChange={(nextOpen) => {
                        if (nextOpen) {
                          setEditor({ isNew: false, draft: { ...filter } });
                        } else if (open) {
                          setEditor(null);
                        }
                      }}
                    >
                      <Popover.Trigger render={trigger} />
                      {open && editor ? (
                        <FilterEditor
                          field={field}
                          draft={editor.draft}
                          onDraftChange={(draft) =>
                            setEditor({ isNew: false, draft })
                          }
                          onCancel={() => setEditor(null)}
                          onApply={applyFilter}
                        />
                      ) : null}
                    </Popover>
                    <Button
                      type="button"
                      size="sm"
                      shape="square"
                      variant="ghost"
                      className="rounded-l-none border-l border-heyo-line"
                      icon={IconX}
                      aria-label={`Remove ${field.label} filter`}
                      onClick={() => removeFilter(filter.id)}
                    />
                  </div>
                );
              })}

              {pendingField && newEditor ? (
                <Popover
                  open
                  onOpenChange={(open) => {
                    if (!open) setEditor(null);
                  }}
                >
                  <Popover.Trigger
                    render={
                      <Button type="button" size="sm" variant="outline">
                        {pendingField.label}
                      </Button>
                    }
                  />
                  <FilterEditor
                    field={pendingField}
                    draft={newEditor.draft}
                    onDraftChange={(draft) => setEditor({ isNew: true, draft })}
                    onCancel={() => setEditor(null)}
                    onApply={applyFilter}
                  />
                </Popover>
              ) : null}

              {hasAppliedFilters && !newEditor ? (
                <AddFilterFieldPicker
                  groups={filterFieldGroups}
                  icon="plus"
                  disabled={!optionsAvailable}
                  onSelect={openNewFilter}
                />
              ) : null}
            </div>
          </div>
        </div>

        {canScrollLeft || canScrollRight ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              shape="square"
              variant="ghost"
              icon={IconChevronLeft}
              disabled={!canScrollLeft}
              aria-label="Scroll filters left"
              onClick={() => scrollFilters("left")}
            />
            <Button
              type="button"
              size="sm"
              shape="square"
              variant="ghost"
              icon={IconChevronRight}
              disabled={!canScrollRight}
              aria-label="Scroll filters right"
              onClick={() => scrollFilters("right")}
            />
          </div>
        ) : null}
      </div>

      {trailingAction ? <div className="shrink-0">{trailingAction}</div> : null}
    </div>
  );
}
