/**
 * "Is this still the value the server gave us?"
 *
 * The panel decides what is unsaved by comparing a control's output with the
 * document it was loaded from, and the naive form of that comparison —
 * `JSON.stringify(a) === JSON.stringify(b)` — answers no to pairs that are the
 * same value:
 *
 * - **Key order.** A rich-text body is stored as JSON. Postgres `jsonb` keeps
 *   objects as a sorted map, so `{"type":"text","text":"hi"}` comes back as
 *   `{"text":"hi","type":"text"}` — identical to ProseMirror, different to
 *   `stringify`. That one difference was enough to mark a document unsaved the
 *   instant it had been saved, every time it was opened again afterwards.
 * - **`undefined` against `null`.** A field absent from the document and a
 *   field explicitly cleared are the same emptiness to every control in the
 *   panel, and `stringify` drops the first and keeps the second.
 *
 * So: compare canonically — keys sorted at every depth, `undefined` read as
 * `null` — and nothing else. This is a value comparison, not a diff; it says
 * equal or not equal and has no opinion about what changed.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object") return value;

  // Only plain JSON reaches this: a document's values are what the API sent
  // and what it will be sent back, and a date is an ISO string on both legs.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(
    entries.map(([key, member]) => [key, canonical(member)]),
  );
}
