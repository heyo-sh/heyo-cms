import { Command, type CommandItem } from "@heyo-sh/heyo-ui";
import {
  IconFileText,
  IconMoon,
  IconPhoto,
  IconPlus,
  IconSettings,
  IconSun,
  IconTrash,
  IconWorld,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { documentTitle } from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import { usePanel } from "../lib/panel";
import { useRouter } from "../lib/router";

/**
 * ⌘K: everything this deployment has, in one list.
 *
 * A panel generated from a configuration can hold forty collections, and the
 * sidebar is a poor way to reach the fourteenth one. The palette lists the
 * places first — they are free, they come from `GET /panel` — and then asks
 * the API for documents whose title matches what has been typed, across every
 * collection that declares a title field and that this account may read.
 *
 * The search is the same `?title[ilike]=` the list screens use, so a result
 * here and a result there are the same query with the same access rules.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { config, theme, toggleTheme } = usePanel();
  const { navigate } = useRouter();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 200);
  /**
   * One object per row id, reused across renders.
   *
   * The palette's rows are rebuilt on every keystroke, and the list keeps its
   * highlight by item *identity*: handing it a fresh object for the same row
   * resets the highlight on every character, so Enter had nothing to run.
   */
  const cache = useRef(new Map<string, CommandItem>());

  // Only collections that have something to match on, and only while the
  // palette is open: a closed palette must not poll the API.
  const searchable = config.collections.filter(
    (collection) => collection.useAsTitle && collection.can.read,
  );

  const found = useAsync<
    { collection: string; label: string; id: string; title: string }[]
  >(
    async (signal) => {
      const term = debounced.trim();
      if (!open || term.length < 2) return [];
      const pages = await Promise.all(
        searchable.slice(0, 6).map(async (collection) => {
          try {
            const page = await api.get<{ docs: Record<string, unknown>[] }>(
              `/${collection.slug}`,
              {
                signal,
                query: {
                  limit: 5,
                  [`${collection.useAsTitle}[ilike]`]: `%${term}%`,
                },
              },
            );
            return page.docs.map((document) => ({
              collection: collection.slug,
              label: collection.label,
              id: String(document.id),
              title: documentTitle(collection, document),
            }));
          } catch {
            // One collection refusing is not the palette failing.
            return [];
          }
        }),
      );
      return pages.flat();
    },
    [debounced, open],
  );

  const items = useMemo<CommandItem[]>(() => {
    const places: CommandItem[] = [
      ...config.collections.map((collection) => ({
        value: `go:/c/${collection.slug}`,
        label: collection.label,
        description: `/c/${collection.slug}`,
        icon: IconFileText,
        group: "Collections",
        keywords: [collection.name, collection.slug],
      })),
      ...config.globals.map((global) => ({
        value: `go:/g/${global.slug}`,
        label: global.label,
        icon: IconWorld,
        group: "Globals",
        keywords: [global.name, global.slug],
      })),
    ];

    const creates: CommandItem[] = config.collections
      .filter((collection) => collection.can.create)
      .map((collection) => ({
        value: `go:/c/${collection.slug}/new`,
        label: `New ${singular(collection.label)}`,
        icon: IconPlus,
        group: "Create",
        keywords: ["new", "create", collection.slug],
      }));

    const library: CommandItem[] = [
      ...(config.media.enabled
        ? [
            {
              value: "go:/media",
              label: "Media",
              icon: IconPhoto,
              group: "Library",
            },
          ]
        : []),
      ...(config.trash.enabled
        ? [
            {
              value: "go:/trash",
              label: "Trash",
              icon: IconTrash,
              group: "Library",
            },
          ]
        : []),
      {
        value: "go:/settings",
        label: "Settings",
        icon: IconSettings,
        group: "Library",
      },
      {
        value: "theme",
        label:
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        icon: theme === "dark" ? IconSun : IconMoon,
        group: "Library",
        keywords: ["theme", "dark", "light", "appearance"],
      },
    ];

    const documents: CommandItem[] = (found.data ?? []).map((entry) => ({
      value: `go:/c/${entry.collection}/${entry.id}`,
      label: entry.title,
      description: entry.label,
      icon: IconFileText,
      group: "Documents",
    }));

    // `Command` hands filtering over as soon as `onQueryChange` is set, which
    // it has to be for the document search. The static rows are matched here
    // instead; the documents arrive already matched by the engine.
    const term = query.trim().toLowerCase();
    const keep = (item: CommandItem) =>
      term === "" ||
      term
        .split(/\s+/)
        .every((part) =>
          [item.label, item.group, ...(item.keywords ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(part),
        );

    const stable = (item: CommandItem): CommandItem => {
      const previous = cache.current.get(item.value);
      if (previous && previous.label === item.label) return previous;
      cache.current.set(item.value, item);
      return item;
    };

    return [
      ...documents,
      ...creates.filter(keep),
      ...places.filter(keep),
      ...library.filter(keep),
    ].map(stable);
  }, [config, theme, found.data, query]);

  const run = useCallback(
    (item: CommandItem) => {
      if (item.value === "theme") {
        toggleTheme();
        return;
      }
      navigate(item.value.slice(3));
    },
    [navigate, toggleTheme],
  );

  /**
   * Enter, when the list has not highlighted anything yet.
   *
   * `Command` hands its roving highlight to Base UI, which arms it on the
   * first arrow key rather than on the first keystroke. That leaves the
   * obvious gesture — ⌘K, type three letters, Enter — doing nothing at all in
   * front of a list of five matches, and "press the down arrow first" is not
   * a thing anybody will discover. Capture phase, and only when nothing is
   * highlighted, so the moment Base UI *does* own the keystroke this stays
   * out of its way.
   */
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      const palette = document.querySelector('[data-slot="command"]');
      if (!palette || palette.querySelector("[data-highlighted]")) return;
      const first = latest.current[0];
      if (!first || first.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      setQuery("");
      run(first);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onOpenChange, run]);

  return (
    <Command
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
      items={items}
      query={query}
      onQueryChange={setQuery}
      loading={found.loading && debounced.trim().length >= 2}
      placeholder="Search documents, or jump to a screen…"
      emptyMessage={
        query.trim().length < 2
          ? "Type at least two letters to search documents."
          : "Nothing matches."
      }
      onSelect={run}
    />
  );
}

/** "Posts" → "post", so the Create row reads like an action. */
function singular(label: string): string {
  const lower = label.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ses")) return lower.slice(0, -2);
  if (lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}
