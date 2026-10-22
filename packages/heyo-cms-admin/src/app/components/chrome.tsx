import { Text, cn } from "@heyo-sh/heyo-ui";
import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * The one notice heyo-ui does not ship, built from the parts it does.
 *
 * Everything else in this panel is a heyo-ui component used directly — there
 * is no local `Button`, no local `Select`, no `cn()` copied into the repo.
 * What lives here is the one way this panel shows a server's refusal. A
 * deployment explaining itself — "this list is code", "keys come from
 * `ai.auth`" — used to be a second box stacked above the content; it is a
 * tooltip on the trail now (`Crumb.hint`), because a sentence that is true
 * forever is read once and costs a line of the table every day after that.
 * The page frame is `components/page`.
 */

/**
 * A screen-level error, which in this panel is always the server's words.
 *
 * Red is a status colour in heyo-ui and nothing else uses it, so a refusal
 * needs no icon-in-a-circle and no heading to be read as one: the tint, the
 * ring and the text tone say it.
 */
export function ErrorNote({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg bg-heyo-danger-tint px-3 py-2 ring-1 ring-heyo-danger/25",
        className,
      )}
    >
      <IconAlertTriangle className="mt-px size-4 shrink-0 text-heyo-danger" />
      <Text size="sm" className="min-w-0 flex-1 break-words text-heyo-danger">
        {message}
      </Text>
    </div>
  );
}
