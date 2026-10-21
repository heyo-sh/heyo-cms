import type { CmsUser, PanelCollection } from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Input,
  Spinner,
  Text,
} from "@heyo-sh/heyo-ui";
import {
  IconLink,
  IconPlus,
  IconSearch,
  IconSearchOff,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";

import { api } from "../lib/api";
import { documentTitle } from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { ErrorNote } from "./chrome";
import type { FieldInputProps } from "./field-input";

/**
 * A `relation` field: pick a document, store its id.
 *
 * Three targets, one control. A collection is searched through its own list
 * endpoint; `cms_users` is searched through `GET /users`, because editors are
 * not a collection and never will be; anything else — a target the panel
 * cannot see, which happens when a relation points at a collection the actor
 * may not read — degrades to the id in a text box rather than to a dead
 * dialog.
 */
export function RelationField({
  field,
  value,
  onChange,
  disabled,
}: FieldInputProps) {
  const { config } = usePanel();
  const target = String(field.options.relationTo ?? "");
  const many = field.options.many === true;
  const collection = config.collections.find(
    (entry) => entry.name === target || entry.slug === target,
  );
  const users = target === "cms_users";
  const [picking, setPicking] = useState(false);

  const ids = many
    ? Array.isArray(value)
      ? (value as string[])
      : []
    : typeof value === "string"
      ? [value]
      : [];

  if (!collection && !users) {
    return (
      <Input
        value={ids[0] ?? ""}
        disabled={disabled}
        aria-label={field.label}
        placeholder={`id of a ${target || "document"}`}
        onChange={(event) => onChange(event.target.value || null)}
      />
    );
  }

  const remove = (id: string) => {
    if (!many) {
      onChange(null);
      return;
    }
    const next = ids.filter((entry) => entry !== id);
    onChange(next.length === 0 ? null : next);
  };

  const add = (id: string) => {
    if (!many) {
      onChange(id);
      setPicking(false);
      return;
    }
    if (ids.includes(id)) return;
    onChange([...ids, id]);
  };

  return (
    <div className="space-y-2">
      {ids.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <RelationChip
              key={id}
              id={id}
              target={target}
              {...(collection ? { collection } : {})}
              {...(disabled ? {} : { onRemove: () => remove(id) })}
            />
          ))}
        </div>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        icon={ids.length === 0 ? IconLink : IconPlus}
        disabled={disabled}
        onClick={() => setPicking(true)}
      >
        {ids.length === 0 ? "Choose" : "Add another"}
      </Button>

      <RelationPicker
        open={picking}
        onOpenChange={setPicking}
        target={target}
        {...(collection ? { collection } : {})}
        onPick={add}
      />
    </div>
  );
}

/**
 * The chosen document, named rather than numbered.
 *
 * One request per chip. A batch endpoint would be better and does not exist:
 * `?where=` with an `in` would do it, and the gain over two or three
 * documents is not worth the first bug in assembling the filter by hand.
 */
function RelationChip({
  id,
  target,
  collection,
  onRemove,
}: {
  id: string;
  target: string;
  collection?: PanelCollection;
  onRemove?: () => void;
}) {
  const entry = useAsync<Record<string, unknown> | null>(
    async (signal) => {
      if (collection) {
        return api.get<Record<string, unknown>>(`/${collection.slug}/${id}`, {
          signal,
        });
      }
      const { user } = await api.get<{ user: CmsUser }>(`/users/${id}`, {
        signal,
      });
      return user as unknown as Record<string, unknown>;
    },
    [id, target],
  );

  const label = entry.data
    ? collection
      ? documentTitle(collection, entry.data)
      : String(entry.data.name ?? entry.data.email ?? id)
    : entry.error
      ? id
      : "…";

  return (
    <Badge variant="outline" className="gap-1.5 py-1">
      <span className="max-w-60 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="rounded-xs opacity-60 hover:opacity-100 heyo-focus"
        >
          <IconX className="size-3" />
        </button>
      ) : null}
    </Badge>
  );
}

function RelationPicker({
  open,
  onOpenChange,
  target,
  collection,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: string;
  collection?: PanelCollection;
  onPick: (id: string) => void;
}) {
  const { locale } = usePanel();
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);

  const results = useAsync<{ id: string; label: string; hint?: string }[]>(
    async (signal) => {
      if (collection) {
        const titleField = collection.useAsTitle;
        const page = await api.get<{ docs: Record<string, unknown>[] }>(
          `/${collection.slug}`,
          {
            signal,
            query: {
              limit: 20,
              locale,
              sort: "-updatedAt",
              // The list endpoint filters by field, not by a search box:
              // `?title[ilike]=%term%` is the same AST the typed client
              // would build, spelled for a URL.
              ...(debounced && titleField
                ? { [`${titleField}[ilike]`]: `%${debounced}%` }
                : {}),
            },
          },
        );
        return page.docs.map((document) => ({
          id: String(document.id),
          label: documentTitle(collection, document),
          hint: String(document.id),
        }));
      }

      const page = await api.get<{ users: CmsUser[] }>("/users", {
        signal,
        query: { limit: 20, ...(debounced ? { search: debounced } : {}) },
      });
      return page.users.map((user) => ({
        id: user.id,
        label: user.name ?? user.email,
        hint: user.email,
      }));
    },
    [debounced, collection?.slug, target, open, locale],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {collection ? `Choose a ${collection.label}` : "Choose an editor"}
          </Dialog.Title>
          <Dialog.Description>
            The document's id is what gets stored.
          </Dialog.Description>
        </Dialog.Header>

        <Dialog.Body className="space-y-3">
          <Input
            autoFocus
            size="sm"
            icon={IconSearch}
            value={search}
            placeholder="Search…"
            aria-label="Search"
            onChange={(event) => setSearch(event.target.value)}
          />
          <ErrorNote error={results.error} />
          {results.loading && !results.data ? (
            <div className="flex justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : results.data && results.data.length > 0 ? (
            <ul className="divide-y divide-heyo-hairline overflow-hidden rounded-lg ring-1 ring-heyo-line">
              {results.data.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onPick(entry.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-heyo-tint heyo-focus"
                  >
                    <span className="truncate">{entry.label}</span>
                    <Text size="xs" tone="subtle" as="span" mono>
                      {entry.hint}
                    </Text>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              icon={IconSearchOff}
              title="Nothing matches"
              description="Nothing in this collection has a title like that."
              hint="The search is the same ?title[ilike]= the list screen uses."
            />
          )}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
