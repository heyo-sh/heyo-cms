import type { PanelField } from "@heyo-sh/heyo-cms/types";
import {
  Checkbox,
  Input,
  Select,
  Switch,
  Text,
  Textarea,
  cn,
} from "@heyo-sh/heyo-ui";
import { useState } from "react";

import { fieldComponent } from "../lib/extensions";
import { MediaField } from "./media-field";
import { RelationField } from "./relation-field";
import { RichTextEditor } from "./rich-text/editor";

/**
 * One field, rendered from its description.
 *
 * The panel never imports a field's `Input` component: the configuration
 * lives on the server, and a function cannot be sent over HTTP. What arrives
 * instead is `PanelField` — the type name and the options — and this file
 * maps a type name to a heyo-ui control.
 *
 * A field type the panel does not know is answered in two steps. First the
 * registry: a plugin may have registered a control for it through the script
 * the panel loaded at boot (`lib/extensions`), and if so that control wins
 * over everything below. Otherwise the built-in control for its shape is
 * used, which is honest and editable rather than hidden — a custom `stars`
 * field is a number input until somebody ships a nicer one.
 *
 * Labels are not passed to the controls here even though heyo-ui's `Input`
 * would draw one: `DocumentForm` owns the label row because it carries the
 * localization badge, the read-only badge and the AI menu alongside it.
 */

export interface FieldInputProps {
  field: PanelField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The whole form state, for the controls that need a sibling's value. */
  document: Record<string, unknown>;
  disabled?: boolean;
  id?: string;
}

export function FieldInput(props: FieldInputProps) {
  const { field, value, onChange, disabled, id } = props;
  const placeholder = field.admin.placeholder;

  const Registered = fieldComponent(field.type);
  if (Registered) return <Registered {...props} />;

  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={id}
          rows={numberOption(field, "rows") ?? 4}
          value={asString(value)}
          disabled={disabled}
          aria-label={field.label}
          {...(placeholder === undefined ? {} : { placeholder })}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );

    case "richText":
      return (
        <RichTextEditor
          value={value as Record<string, unknown> | null}
          onChange={onChange}
          disabled={disabled === true}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
      );

    case "number":
      return (
        <Input
          id={id}
          type="number"
          inputMode={field.options.integer === true ? "numeric" : "decimal"}
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          aria-label={field.label}
          {...numberBounds(field)}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === "" ? null : Number(next));
          }}
        />
      );

    case "boolean":
      return (
        <div className="flex h-8 items-center">
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            aria-label={field.label}
            onCheckedChange={onChange}
          />
        </div>
      );

    case "date":
      return <DateInput {...props} />;

    case "select":
      return (
        <Select
          value={asString(value)}
          disabled={disabled}
          onValueChange={(next) => onChange(next)}
        >
          <Select.Trigger
            id={id}
            aria-label={field.label}
            {...(placeholder === undefined ? {} : { placeholder })}
          />
          <Select.Content items={choices(field)} />
        </Select>
      );

    case "multiselect":
      return <MultiselectInput {...props} />;

    case "media":
      return <MediaField {...props} />;

    case "relation":
      return <RelationField {...props} />;

    case "json":
      return <JsonInput {...props} />;

    case "email":
    case "url":
    case "text":
    default:
      return (
        <Input
          id={id}
          type={field.type === "email" ? "email" : "text"}
          value={asString(value)}
          disabled={disabled}
          aria-label={field.label}
          {...(placeholder === undefined ? {} : { placeholder })}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
  }
}

/**
 * A date, in the browser's own picker.
 *
 * heyo-ui ships a `DatePicker`, and it opens a calendar rather than parsing
 * text — the right call for a date somebody chooses. This field is often a
 * timestamp with a minute on it, which a calendar cannot express, so the
 * native control is used and the only work here is between
 * `2024-05-01T09:30:00.000Z` and what `<input type="datetime-local">` wants,
 * which is local time without a zone.
 */
function DateInput({ field, value, onChange, disabled, id }: FieldInputProps) {
  const mode = field.options.mode === "date" ? "date" : "datetime-local";
  const text = toInputDate(asString(value), mode);

  return (
    <Input
      id={id}
      type={mode}
      value={text}
      disabled={disabled}
      aria-label={field.label}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "") {
          onChange(null);
          return;
        }
        const parsed = new Date(next);
        onChange(Number.isNaN(parsed.getTime()) ? null : parsed.toISOString());
      }}
    />
  );
}

function MultiselectInput({
  field,
  value,
  onChange,
  disabled,
}: FieldInputProps) {
  const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg bg-heyo-control px-2.5 py-2 ring-1 ring-heyo-line">
      {choices(field).map((choice) => (
        <Checkbox
          key={choice.value}
          label={choice.label}
          checked={selected.has(choice.value)}
          disabled={disabled}
          onCheckedChange={(checked) => {
            const next = new Set(selected);
            if (checked) next.add(choice.value);
            else next.delete(choice.value);
            onChange(next.size === 0 ? null : [...next]);
          }}
        />
      ))}
    </div>
  );
}

/**
 * Raw JSON, validated as it is typed.
 *
 * The text is kept in local state rather than parsed on every keystroke,
 * because half-typed JSON is not a value and writing `null` into the document
 * while somebody is mid-object would lose what they had.
 */
function JsonInput({ field, value, onChange, disabled, id }: FieldInputProps) {
  const [text, setText] = useState(() =>
    value === null || value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [invalid, setInvalid] = useState(false);

  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        rows={6}
        spellCheck={false}
        value={text}
        disabled={disabled}
        aria-label={field.label}
        className={cn("font-mono text-xs", invalid && "ring-heyo-danger/50")}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === "") {
            setInvalid(false);
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? (
        <Text size="xs" className="text-heyo-danger">
          Not valid JSON yet — the last valid value is what will be saved.
        </Text>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Option readers
// ---------------------------------------------------------------------------

export function choices(field: PanelField): { value: string; label: string }[] {
  const raw = field.options.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((choice) =>
    typeof choice === "string"
      ? { value: choice, label: choice }
      : {
          value: String((choice as { value?: unknown }).value ?? ""),
          label: String(
            (choice as { label?: unknown; value?: unknown }).label ??
              (choice as { value?: unknown }).value ??
              "",
          ),
        },
  );
}

function numberOption(field: PanelField, key: string): number | undefined {
  const value = field.options[key];
  return typeof value === "number" ? value : undefined;
}

function numberBounds(field: PanelField): {
  min?: number;
  max?: number;
  step?: number;
} {
  const min = numberOption(field, "min");
  const max = numberOption(field, "max");
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(field.options.integer === true ? { step: 1 } : {}),
  };
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function toInputDate(value: string, mode: "date" | "datetime-local"): string {
  if (value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (mode === "date") return day;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
