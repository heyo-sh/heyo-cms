import { Button, Label, Text, Tooltip } from "@heyo-sh/heyo-ui";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useId, useRef } from "react";

import { FieldInput, type FieldInputProps } from "./field-input";

type Row = Record<string, unknown>;

/**
 * A `list` field: rows of the same few fields, edited in place.
 *
 * Each row is a small form — the row's fields with their labels, drawn by the
 * same `FieldInput` as the document's own fields — with buttons to move it
 * and remove it, and one to add a row at the end. The value is the array of
 * row objects, or `null` once the last row is gone, the way an empty
 * multiselect is.
 *
 * Rows have no ids of their own, so the keys React needs are kept beside
 * them: an index key would hand a moved row's controls to its neighbour.
 */
export function ListField(props: FieldInputProps) {
  const { field, value, onChange, disabled, id } = props;
  const rowFields = field.fields ?? [];
  const rows = Array.isArray(value) ? (value as Row[]) : [];
  const max =
    typeof field.options.maxItems === "number"
      ? field.options.maxItems
      : undefined;
  const base = useId();

  const next = useRef(0);
  const keys = useRef<string[]>([]);
  while (keys.current.length < rows.length) {
    keys.current.push(`row-${next.current++}`);
  }
  if (keys.current.length > rows.length) keys.current.length = rows.length;

  const commit = (nextRows: Row[], nextKeys: string[]): void => {
    keys.current = nextKeys;
    onChange(nextRows.length === 0 ? null : nextRows);
  };

  const blank = (): Row =>
    Object.fromEntries(
      rowFields.map((item) => [item.name, item.defaultValue ?? null]),
    );

  const add = (): void =>
    commit([...rows, blank()], [...keys.current, `row-${next.current++}`]);

  const remove = (index: number): void =>
    commit(
      rows.filter((_, position) => position !== index),
      keys.current.filter((_, position) => position !== index),
    );

  const move = (index: number, by: -1 | 1): void => {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const nextRows = [...rows];
    const nextKeys = [...keys.current];
    [nextRows[index], nextRows[target]] = [nextRows[target]!, nextRows[index]!];
    [nextKeys[index], nextKeys[target]] = [nextKeys[target]!, nextKeys[index]!];
    commit(nextRows, nextKeys);
  };

  const update = (index: number, name: string, value: unknown): void =>
    commit(
      rows.map((row, position) =>
        position === index ? { ...row, [name]: value } : row,
      ),
      keys.current,
    );

  const full = max !== undefined && rows.length >= max;

  return (
    <div id={id} role="group" aria-label={field.label} className="space-y-2">
      {rows.length > 0 ? (
        <ol className="space-y-2">
          {rows.map((row, index) => {
            const number = index + 1;
            return (
              <li
                key={keys.current[index]}
                aria-label={`${field.label}, row ${number}`}
                className="space-y-3 rounded-lg p-3 ring-1 ring-heyo-line"
              >
                <div className="-mt-1 -mr-1 flex items-center gap-0.5">
                  <Text size="xs" tone="subtle" className="flex-1 tabular-nums">
                    {number}
                  </Text>
                  <RowButton
                    label={`Move row ${number} up`}
                    icon={IconArrowUp}
                    disabled={disabled === true || index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <RowButton
                    label={`Move row ${number} down`}
                    icon={IconArrowDown}
                    disabled={disabled === true || index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <RowButton
                    label={`Remove row ${number}`}
                    icon={IconTrash}
                    disabled={disabled === true}
                    onClick={() => remove(index)}
                  />
                </div>

                {rowFields.map((item) => {
                  const control = `${base}-${index}-${item.name}`;
                  return (
                    <div key={item.name}>
                      <Label
                        htmlFor={control}
                        className="mb-1 text-heyo-subtle"
                      >
                        {item.label}
                        {item.required ? (
                          <span
                            aria-hidden
                            title="Required"
                            className="ml-0.5 text-heyo-danger"
                          >
                            *
                          </span>
                        ) : null}
                      </Label>
                      <FieldInput
                        id={control}
                        field={item}
                        value={row[item.name] ?? null}
                        document={row}
                        {...(disabled === undefined ? {} : { disabled })}
                        onChange={(value) => update(index, item.name, value)}
                      />
                      {item.description ? (
                        <Text size="xs" tone="subtle" className="mt-1">
                          {item.description}
                        </Text>
                      ) : null}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ol>
      ) : (
        <Text size="sm" tone="subtle">
          No rows yet.
        </Text>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        icon={IconPlus}
        disabled={disabled === true || full}
        onClick={add}
      >
        Add row
      </Button>
    </div>
  );
}

function RowButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof IconTrash;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        shape="square"
        icon={icon}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );
}
