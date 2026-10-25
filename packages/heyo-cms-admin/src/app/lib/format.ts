import type { PanelCollection, PanelField } from "@heyo-sh/heyo-cms/types";

/**
 * Dates, sizes and countdowns, in the browser's own locale.
 *
 * `Intl` rather than a date library: the panel formats five shapes of value
 * and the platform has formatted all five since 2017. The countdown is the
 * one with a rule behind it — the trash and the media library both show "how
 * long until this is gone", and that number has to come from the deadline the
 * server set, never from a duration the panel re-derives.
 */

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateOnly.format(date);
}

/** `3 days ago`, `in 2 hours`. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const seconds = (date.getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return relative.format(Math.round(seconds), "second");
}

/**
 * Whole days until a deadline the server set.
 *
 * `null` means there is no deadline — retention is off, and the file or
 * document keeps serving forever. Zero means today, which the caller renders
 * as "today" rather than "0 days".
 */
export function daysUntil(deadline: string | null | undefined): number | null {
  if (!deadline) return null;
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

export function formatCountdown(deadline: string | null | undefined): string {
  const days = daysUntil(deadline);
  if (days === null) return "kept";
  if (days === 0) return "today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * What to call a row.
 *
 * `useAsTitle` was already resolved by the server, which knows the field
 * list; this only has to cope with the value being missing, which for a
 * freshly created document it routinely is.
 */
export function documentTitle(
  collection: PanelCollection,
  document: Record<string, unknown>,
): string {
  const field = collection.useAsTitle;
  const value = field ? document[field] : undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number") return String(value);
  const id = document.id;
  return typeof id === "string" ? id : "Untitled";
}

/** A short, honest rendering of any field value for a table cell. */
export function cellText(field: PanelField, value: unknown): string {
  if (value === null || value === undefined) return "—";
  switch (field.type) {
    case "boolean":
      return value === true ? "Yes" : "No";
    case "date":
      return typeof value === "string"
        ? field.options.mode === "date"
          ? formatDate(value)
          : formatDateTime(value)
        : "—";
    case "richText":
      return richTextPreview(value);
    case "multiselect":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "json":
      return JSON.stringify(value).slice(0, 80);
    case "list":
      return Array.isArray(value)
        ? `${value.length} ${value.length === 1 ? "row" : "rows"}`
        : "—";
    default:
      if (typeof value === "object") return JSON.stringify(value).slice(0, 80);
      return String(value);
  }
}

/** The first words of a ProseMirror document, for a list cell. */
export function richTextPreview(value: unknown): string {
  const text: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") text.push(record.text);
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(value);
  const joined = text.join(" ").trim();
  return joined.length > 90 ? `${joined.slice(0, 90)}…` : joined || "—";
}
