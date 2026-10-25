import { Button, Input, Text } from "@heyo-sh/heyo-ui";
import { IconArrowBackUp, IconPlus, IconX } from "@tabler/icons-react";
import { useState } from "react";

import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { toast } from "../lib/toast";
import { ErrorNote } from "./chrome";
import type { FieldInputProps } from "./field-input";

/**
 * A `slug` field: the slug itself, and — with `history` — the addresses the
 * document used to have.
 *
 * The input is a plain text box on purpose. Cleaning happens on the server,
 * on save, by the same function that cleans an import or an API write; a
 * second, browser-side opinion about what "Łódź" becomes would sooner or
 * later disagree with it. An empty box is a request to make the slug from
 * its source field, which is why the placeholder says so.
 *
 * The previous slugs are edited directly, not through the form: they are
 * not a field of the document but where its old URLs lead, and a change to
 * them takes effect at once — like a redirect in any other tool.
 */
export function SlugField(props: FieldInputProps) {
  const { field, value, onChange, disabled, id } = props;
  const from = typeof field.options.from === "string" ? field.options.from : null; // prettier-ignore
  const history = field.options.history === true;

  return (
    <div className="space-y-2">
      <Input
        id={id}
        type="text"
        value={value === null || value === undefined ? "" : String(value)}
        disabled={disabled}
        aria-label={field.label}
        spellCheck={false}
        autoCapitalize="off"
        placeholder={
          field.admin.placeholder ??
          (from ? `Made from ${from} when saved empty` : "lowercase-with-hyphens") // prettier-ignore
        }
        onChange={(event) => onChange(event.target.value || null)}
      />
      {history && props.collection && props.documentId ? (
        <PreviousSlugs
          collection={props.collection}
          documentId={props.documentId}
          field={field.name}
          {...(props.locale === undefined ? {} : { locale: props.locale })}
          disabled={disabled === true}
        />
      ) : null}
    </div>
  );
}

interface PreviousSlug {
  slug: string;
  field: string;
  locale: string | null;
  createdAt: string | null;
}

function PreviousSlugs({
  collection,
  documentId,
  field,
  locale,
  disabled,
}: {
  collection: string;
  documentId: string;
  field: string;
  locale?: string;
  disabled: boolean;
}) {
  const path = `/${collection}/${encodeURIComponent(documentId)}/previous-slugs`;
  const query = { field, ...(locale === undefined ? {} : { locale }) };
  const list = useAsync(
    (signal) => api.get<PreviousSlug[]>(path, { query, signal }),
    [path, field, locale],
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (change: () => Promise<PreviousSlug[]>) => {
    setBusy(true);
    setError(null);
    try {
      list.set(await change());
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const slug = draft.trim();
    if (!slug) return;
    const added = await run(
      () =>
      api.post<PreviousSlug[]>(path, { body: { slug, field, ...(locale === undefined ? {} : { locale }) } }), // prettier-ignore
    );
    if (added) {
      setDraft("");
      toast.success(`"${slug}" now leads here.`);
    }
  };

  const remove = (slug: string) =>
    run(() => api.delete<PreviousSlug[]>(path, { query: { ...query, slug } }));

  const entries = list.data ?? [];
  return (
    <div className="space-y-1.5" aria-label="Previous slugs">
      <Text size="xs" tone="subtle">
        Previous slugs — old addresses that still lead here
      </Text>
      {entries.length === 0 && !list.loading ? (
        <Text size="xs" tone="subtle">
          None yet. A changed slug is added here when you save.
        </Text>
      ) : null}
      {entries.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <li
              key={`${entry.locale ?? ""}:${entry.slug}`}
              className="inline-flex items-center gap-1 rounded-md bg-heyo-control px-2 py-0.5 text-xs ring-1 ring-heyo-line"
            >
              <IconArrowBackUp
                className="size-3 text-heyo-inactive"
                aria-hidden
              />
              <span className="font-mono">{entry.slug}</span>
              <button
                type="button"
                className="ml-0.5 rounded text-heyo-inactive hover:text-heyo-danger disabled:opacity-50"
                aria-label={`Stop "${entry.slug}" leading here`}
                disabled={disabled || busy}
                onClick={() => void remove(entry.slug)}
              >
                <IconX className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Not a <form>: this sits inside the document's form, and Enter here
          must add a slug, not save the document. */}
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          value={draft}
          disabled={disabled || busy}
          aria-label="Add a previous slug"
          placeholder="old-address-to-redirect"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void add();
          }}
        />
        <Button
          type="button"
          size="base"
          variant="outline"
          icon={IconPlus}
          disabled={disabled || busy || draft.trim() === ""}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      <ErrorNote error={error ?? list.error} />
    </div>
  );
}
