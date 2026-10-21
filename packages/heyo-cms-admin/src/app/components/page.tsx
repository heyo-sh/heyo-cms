import {
  Breadcrumb,
  Separator,
  Sidebar,
  Spinner,
  Tooltip,
  cn,
} from "@heyo-sh/heyo-ui";
import { IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { Link } from "../lib/router";
import { LocaleSwitcher } from "./locale-switcher";
import { UsageHelper, type Usage } from "./usage-helper";

/**
 * The one bar every screen wears.
 *
 * There used to be two: the shell drew a strip with the language and the
 * colour scheme in it, and the document screen drew a second one underneath
 * with the trail and the buttons. Twenty-four pixels of chrome were spent
 * saying nothing twice, and on a laptop that is a line of the article.
 *
 * So there is one row now, and it answers the three questions a bar is for:
 * **where am I** (the trail, which is the navigation — the sidebar says what
 * exists, the trail says where you are inside it), **which language am I
 * editing** (at the trail's level, because the language is part of the
 * address of what is on screen — `posts / my-article / de` is a different
 * document from `posts / my-article / en`), and **what can I do here**.
 *
 * Nothing in it is decorative: the colour-scheme toggle moved into the
 * account menu, where a preference set twice a year belongs, and the title
 * stopped being repeated as a heading under a trail that already says it.
 */

export interface Crumb {
  label: ReactNode;
  /** A panel path. The last crumb is the current page and takes none. */
  to?: string;
  /**
   * The one rule of the screen that the screen itself cannot show — a purge
   * deadline, a retention window, what "unused" means here.
   *
   * It is a tooltip on a glyph to the left of the crumb rather than a
   * paragraph above the content: a sentence that is true forever is read
   * once and then costs a line of the table every day after that.
   */
  hint?: ReactNode;
}

export function PageBar({
  crumbs,
  status,
  actions,
  usage,
  locale = false,
  className,
}: {
  crumbs: Crumb[];
  /** Badges that qualify the current page: unsaved, trashed, scheduled. */
  status?: ReactNode;
  actions?: ReactNode;
  /** Context for the optional API integration guide, always last in the bar. */
  usage?: Usage;
  /** The owning route opts in when changing language is relevant. */
  locale?: boolean;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 px-3",
        "border-b border-heyo-hairline bg-heyo-canvas/85 backdrop-blur-md",
        className,
      )}
    >
      <Sidebar.Trigger />
      <Separator orientation="vertical" className="h-4" />

      <Breadcrumb
        maxItems={4}
        // Below `sm` the trail collapses to where you are. Four crumbs
        // sharing 200 pixels truncate to "I › N", which is worse than no
        // trail at all — the sidebar is one tap away on that screen anyway.
        //
        // `ml-1` on top of the row's gap: the trail reads as text, and text
        // set flush against the rule beside the sidebar trigger looks stuck
        // to it.
        className="ml-1 min-w-0 [&_li:not(:last-child)]:hidden sm:[&_li:not(:last-child)]:flex"
        items={crumbs.map((crumb) => ({
          label: crumb.hint ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <CrumbHint>{crumb.hint}</CrumbHint>
              <span className="min-w-0 truncate">{crumb.label}</span>
            </span>
          ) : (
            crumb.label
          ),
          ...(crumb.to ? { render: <Link to={crumb.to} /> } : {}),
        }))}
      />

      <span className="min-w-2 flex-1" />

      {status ? (
        <div className="flex shrink-0 items-center gap-1.5">{status}</div>
      ) : null}

      {/* Language is part of the address, but it belongs with the right-side
          controls: on an editor it sits directly before Save rather than
          interrupting the breadcrumb. */}
      {locale ? <LocaleSwitcher /> : null}

      {actions ? (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
      {usage ? <UsageHelper usage={usage} /> : null}
    </header>
  );
}

/** The glyph that carries a crumb's hint. A span, so the tooltip has a
 *  trigger that takes a ref and the icon keeps its own size. */
function CrumbHint({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <span
        tabIndex={0}
        aria-label="About this screen"
        className="inline-flex shrink-0 cursor-help items-center rounded text-heyo-inactive transition-colors hover:text-heyo-subtle heyo-focus"
      >
        <IconInfoCircle className="size-3.5" />
      </span>
    </Tooltip>
  );
}

/**
 * The one way this panel says "fetching".
 *
 * One spinner, centred in the area the screen is about to fill, and never
 * two at once: a screen waiting on three requests is a screen that is
 * loading, not three screens. Rendered in place of the body rather than
 * inside it, so the measure, the padding and the scrollbar arrive with the
 * content instead of around an empty box.
 */
export function PageLoader({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-60 min-w-0 flex-1 items-center justify-center p-6",
        className,
      )}
    >
      <Spinner size="sm" label="Loading" />
    </div>
  );
}

/**
 * A second strip under the bar, for a screen that has sections of its own.
 *
 * The sidebar's search-and-AI row is 3rem tall plus its header's bottom
 * hairline, so this strip is 3rem + 1px to meet that hairline exactly.
 * With a matching inset, it is the bar's continuation, not a
 * toolbar floating inside the content. Settings uses it for its tabs: the
 * trail stays "Settings" on every tab because the tab row
 * is already saying which one you are on, and a trail that repeats the
 * segmented control two centimetres above it is two answers to one question.
 */
export function PageStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[3.0625rem] shrink-0 items-center gap-2 px-2",
        "border-b border-heyo-hairline bg-heyo-canvas",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The body under the bar: one scroller, one measure, one rhythm.
 *
 * `flush` is for the screens that own their own scrolling — the document
 * editor splits into two independently scrolling columns, and a page-level
 * scrollbar around that is the thing that makes a two-pane editor feel
 * broken.
 */
export function PageBody({
  children,
  width = "wide",
  flush,
  className,
}: {
  children: ReactNode;
  /**
   * `wide` is for anything that earns the width — a table, a grid of cards,
   * two panes. `column` is for a screen that is one stack of fields, where
   * 72rem of measure means a label on the far left and its input somewhere
   * near the next time zone. A global, or a collection without sidebar
   * fields, is the second kind.
   */
  width?: "wide" | "column";
  flush?: boolean;
  className?: string;
}) {
  if (flush) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto heyo-scrollbar">
      <div
        className={cn(
          "mx-auto w-full space-y-5 p-4 md:p-6",
          width === "column" ? "max-w-2xl" : "max-w-6xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The frame a screen sits in: the bar, then the body, and nothing else.
 *
 * `className` lets a screen extend the root layout when it needs more than
 * a bar and one scrolling body.
 */
export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col transition-[padding] duration-250 ease-heyo",
        className,
      )}
    >
      {children}
    </div>
  );
}
