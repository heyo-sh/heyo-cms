import type { KeyboardEvent } from "react";

/**
 * A table row that opens something.
 *
 * The record is the row, not the word in its first cell. A title rendered as
 * a link makes a 1200px-wide row into a 90px target, and every editor who has
 * used a CMS clicks the row — so the row is what answers, and the title is
 * plain text inside it.
 *
 * Which means the keyboard has to get the same deal: a `<tr>` is not
 * focusable, so this adds the tab stop and Enter. `event.target !==
 * currentTarget` keeps it out of the way of controls inside the row — Enter
 * in a cell's select belongs to the select.
 *
 * ```tsx
 * <Table.Row {...openable(() => navigate(`/c/posts/${id}`))}>
 * ```
 *
 * heyo-ui 0.3.1 does all of this from `<Table.Row onClick>` alone
 * ([heyo-ui#10](https://github.com/heyo-sh/heyo-ui/pull/10)); this goes with
 * the release that carries it.
 */
export function openable(open: () => void): {
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  tabIndex: number;
  className: string;
} {
  return {
    onClick: open,
    onKeyDown: (event) => {
      if (event.key !== "Enter" || event.target !== event.currentTarget) return;
      event.preventDefault();
      open();
    },
    tabIndex: 0,
    className: "cursor-pointer heyo-focus",
  };
}

/** For the cells that hold their own controls: a click there is not the row. */
export const stopRowClick = {
  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
};
