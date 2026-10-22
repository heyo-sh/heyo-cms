import type {
  AiMutationTarget,
  AiPageContext,
  AiPlanSummary,
} from "@heyo-sh/heyo-cms/types";
import {
  Badge,
  Button,
  Input,
  Kbd,
  ScrollArea,
  Spinner,
  Text,
  Textarea,
  Tooltip,
  cn,
} from "@heyo-sh/heyo-ui";
import {
  IconAlertTriangle,
  IconArrowUp,
  IconCheck,
  IconPlayerStop,
  IconPlus,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { usePanel } from "../lib/panel";
import {
  useAssistant,
  type AssistantStep,
  type AssistantTurn,
} from "../lib/assistant";
import { Link, useRouter } from "../lib/router";
import { toast } from "../lib/toast";

/**
 * The assistant, as the panel wears it.
 *
 * Two states and one piece of chrome. Closed, it is a centred composer at the
 * foot of the window — on every screen, not only where a document happens to
 * be. Open, the conversation moves into a drawer on the right and the page
 * stays live underneath it: the editor can navigate, open the record the
 * assistant just changed and keep talking, which is the entire reason this
 * replaced a chat that was nailed to one document.
 *
 * It is rendered once, in `Shell`, and its state lives above the router. A
 * conversation that belonged to a screen would be thrown away every time
 * somebody clicked a link to check something.
 *
 * The composer is visible even when the assistant cannot run. A disabled
 * field that names its reason is a problem somebody can fix; a feature that
 * silently is not there is one nobody reports.
 *
 * Both surfaces are mounted at all times and move rather than appear. A
 * conditional render cannot be animated — the drawer blinked into existence
 * and the composer blinked out, next to a sidebar that slides — and it would
 * also throw away the drawer's scroll position and whatever was half-typed in
 * the composer. They travel on the sidebar's own clock
 * (`--heyo-sidebar-duration`, `ease-heyo`), so the three moving parts of the
 * window read as one gesture, and whichever is off screen is `inert`: out of
 * sight has to mean out of the tab order too.
 */
export function AiAssistant() {
  const { open } = useAssistant();
  return (
    <>
      <CentreComposer hidden={open} />
      <AssistantDrawer open={open} />
    </>
  );
}

function CentreComposer({ hidden }: { hidden: boolean }) {
  const { send, unavailable } = useAssistant();
  const [message, setMessage] = useState("");
  const disabled = unavailable !== null;
  const submit = (
    <Button
      size="xs"
      shape="square"
      variant="outline"
      icon={IconArrowUp}
      aria-label="Send"
      disabled={disabled || message.trim() === ""}
      onClick={() => {
        send(message);
        setMessage("");
      }}
    />
  );
  const composer = (
    <Input
      size="lg"
      className="text-sm"
      value={message}
      disabled={disabled}
      aria-label="Ask the assistant"
      placeholder="Ask AI to change content…"
      suffix={
        disabled ? (
          submit
        ) : (
          <Tooltip content={<Kbd>⏎</Kbd>}>
            <span>{submit}</span>
          </Tooltip>
        )
      }
      onChange={(event) => setMessage(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          send(message);
          setMessage("");
        }
      }}
    />
  );

  return (
    <div
      data-slot="assistant-centre-composer"
      data-state={hidden ? "hidden" : "visible"}
      {...(hidden ? { inert: true } : {})}
      className={cn(
        // Match the docs' `center` entry point: a narrow, one-line control
        // centred on the viewport, rather than a wide bar across the panel.
        "fixed bottom-4 left-1/2 z-40 m-0 w-[calc(100%-2rem)] max-w-[23rem] -translate-x-1/2",
        // It leaves the way it came: downwards, past its own height and the
        // gap under it, so nothing is left peeking over the bottom edge.
        "transition-[translate,opacity] duration-(--heyo-sidebar-duration) ease-heyo",
        "motion-reduce:transition-none",
        hidden && "pointer-events-none translate-y-[calc(100%+2rem)] opacity-0",
      )}
    >
      {disabled ? (
        <Tooltip content="AI is disabled. Enable it in the CMS configuration.">
          <span className="block">{composer}</span>
        </Tooltip>
      ) : (
        composer
      )}
    </div>
  );
}

function AssistantDrawer({ open }: { open: boolean }) {
  const { config } = usePanel();
  const { setOpen, turns, streaming, stop, clear, unavailable, send } =
    useAssistant();
  const [message, setMessage] = useState("");
  const tail = useRef<HTMLDivElement>(null);

  // Only while it is on screen: scrolling an element that is parked outside
  // the viewport asks the browser to bring the whole drawer into view, which
  // is a horizontal jump of the page behind it.
  useEffect(() => {
    if (!open) return;
    tail.current?.scrollIntoView({ block: "end" });
  }, [turns, streaming, open]);

  return (
    // Deliberately not a modal dialog. The point of the open state is that
    // the page under it keeps working: the editor navigates to the record the
    // assistant changed while the conversation stays where it is. A backdrop
    // and a focus trap would make that impossible.
    <aside
      aria-label="AI assistant"
      data-state={open ? "open" : "closed"}
      {...(open ? {} : { inert: true })}
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col",
        "border-l border-heyo-line bg-heyo-base shadow-lg",
        // The same slide as the sidebar's mobile drawer, from the same
        // variable: in from the edge it is anchored to, out to beyond it.
        "transition-transform duration-(--heyo-sidebar-duration) ease-heyo",
        "motion-reduce:transition-none",
        !open && "translate-x-full",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-heyo-hairline px-4 py-3">
        <IconSparkles className="size-4 shrink-0 text-heyo-subtle" />
        <Text size="sm" className="flex-1 font-medium text-heyo-strong">
          Assistant
        </Text>
        {config.ai.defaultModel && !unavailable ? (
          <Badge variant="neutral" size="sm">
            {config.ai.defaultModel.model}
          </Badge>
        ) : null}
        {turns.length > 0 ? (
          <Tooltip content="Start a new conversation">
            <span>
              <Button
                size="xs"
                variant="ghost"
                shape="square"
                icon={IconPlus}
                aria-label="New conversation"
                onClick={clear}
              />
            </span>
          </Tooltip>
        ) : null}
        <Tooltip content="Hide. The conversation is kept.">
          <span>
            <Button
              size="xs"
              variant="ghost"
              shape="square"
              icon={IconX}
              aria-label="Close the assistant"
              onClick={() => setOpen(false)}
            />
          </span>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-4 py-4">
        <div className="flex flex-col gap-4">
          {turns.map((turn, index) => (
            <Turn key={index} turn={turn} />
          ))}
          {streaming && turns.at(-1)?.text === "" ? (
            <div className="flex items-center gap-2">
              <Spinner size="sm" />
              <Text size="xs" tone="subtle">
                Working…
              </Text>
            </div>
          ) : null}
          <div ref={tail} />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-heyo-hairline bg-heyo-elevated p-3">
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={() => {
            send(message);
            setMessage("");
          }}
          disabled={unavailable}
          placeholder="Ask a follow-up…"
          {...(streaming ? { onStop: stop } : {})}
        />
      </div>
    </aside>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  /** The reason it cannot run, or `null`. */
  disabled: string | null;
  placeholder: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const submitControl = onStop ? (
    <Button size="xs" variant="outline" icon={IconPlayerStop} onClick={onStop}>
      Stop
    </Button>
  ) : (
    <Tooltip content={disabled ?? <Kbd>⏎</Kbd>}>
      <span>
        <Button
          size="xs"
          shape="square"
          variant="primary"
          icon={IconArrowUp}
          aria-label="Send"
          disabled={disabled !== null || value.trim() === ""}
          onClick={onSubmit}
        />
      </span>
    </Tooltip>
  );

  return (
    <div
      className={cn(
        "rounded-xl bg-heyo-base ring-1 ring-heyo-line transition-shadow",
        "focus-within:ring-[1.5px] focus-within:ring-heyo-focus/45",
        disabled && "bg-heyo-recessed",
      )}
    >
      <Textarea
        ref={field}
        rows={2}
        value={value}
        disabled={disabled !== null}
        aria-label="Ask the assistant"
        placeholder={disabled ?? placeholder}
        className={cn(
          // The composer owns its border and focus ring. The field is glass
          // inside it, just as the centred docs composer is.
          "w-full border-0 bg-transparent text-sm shadow-none ring-0 inset-shadow-none focus:ring-0",
          "text-heyo-default heyo-placeholder heyo-scrollbar",
          "disabled:cursor-not-allowed disabled:text-heyo-inactive",
          "resize-none px-3 pt-2.5",
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
        <span className="flex-1" />
        {submitControl}
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: AssistantTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <Text
          size="sm"
          className="max-w-[85%] rounded-xl rounded-br-sm bg-heyo-recessed px-3 py-2 whitespace-pre-wrap"
        >
          {turn.text}
        </Text>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {turn.steps && turn.steps.length > 0 ? (
        <div className="flex flex-col gap-1">
          {turn.steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </div>
      ) : null}

      {turn.text.length > 0 ? (
        // Plain text, deliberately. No `dangerouslySetInnerHTML` and no
        // Markdown renderer: the answer is produced by a model that has just
        // read editor-supplied content, and the cheapest way to be certain it
        // cannot inject anything is for it never to become HTML.
        <Text size="sm" className="whitespace-pre-wrap">
          {turn.text}
        </Text>
      ) : null}

      {turn.mutations?.map((mutation, index) => (
        <SavedCard
          key={index}
          target={mutation.target}
          fields={mutation.fields}
        />
      ))}

      {turn.plans?.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}

      {turn.error ? (
        <div className="flex items-start gap-2 rounded-lg bg-heyo-danger-tint p-2">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-heyo-danger" />
          <Text size="xs" className="text-heyo-danger">
            {turn.error.message}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One tool call, as a line the editor can read.
 *
 * The label and the summary both come from the server. Neither the tool's
 * arguments nor its result appear: a trace that printed them would put field
 * values on screen that the surrounding page may be deliberately hiding.
 */
function Step({ step }: { step: AssistantStep }) {
  return (
    <div className="flex items-center gap-2">
      {step.summary ? (
        <IconCheck className="size-3 shrink-0 text-heyo-subtle" />
      ) : (
        <Spinner size="sm" />
      )}
      <Text size="xs" tone="subtle">
        {step.summary ?? step.label}
      </Text>
    </div>
  );
}

function SavedCard({
  target,
  fields,
}: {
  target: AiMutationTarget;
  fields: string[];
}) {
  const href = linkFor(target);
  return (
    <div className="rounded-lg bg-heyo-recessed p-2 ring-1 ring-heyo-hairline">
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="success" size="sm" icon={IconCheck}>
          Saved
        </Badge>
        {href ? (
          <Link
            to={href}
            className="truncate text-xs text-heyo-brand underline"
          >
            {target.collection ?? target.kind} · {target.id}
          </Link>
        ) : (
          <Text size="xs" tone="subtle" as="span">
            {target.kind} · {target.id}
          </Text>
        )}
      </div>
      <Text size="xs" tone="subtle">
        {fields.length > 0 ? fields.join(", ") : "no fields changed"}
        {target.locale ? ` · ${target.locale}` : ""}
      </Text>
    </div>
  );
}

/**
 * A change waiting for a human.
 *
 * It names the number of records and the fields, and nothing else. Printing
 * the proposed values would make this the kind of dialog people dismiss
 * without reading, which is the failure the approval step exists to prevent.
 */
function PlanCard({ plan }: { plan: AiPlanSummary }) {
  const { approve } = useAssistant();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const records = plan.operations.length;
  const fields = [
    ...new Set(plan.operations.flatMap((operation) => operation.fields)),
  ];

  if (done) return null;

  return (
    <div className="rounded-lg bg-heyo-warning-tint p-2.5 ring-1 ring-heyo-hairline">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="warning" size="sm">
          Needs approval
        </Badge>
        <Text size="xs" tone="subtle" as="span">
          {records} record{records === 1 ? "" : "s"}
        </Text>
      </div>

      <Text size="sm">{plan.summary}</Text>

      <ul className="mt-1.5 flex flex-col gap-0.5">
        {plan.operations.slice(0, 5).map((operation, index) => (
          <li key={index}>
            <Text size="xs" tone="subtle">
              {operation.action} · {operation.label}
              {operation.fields.length > 0
                ? ` (${operation.fields.join(", ")})`
                : ""}
            </Text>
          </li>
        ))}
        {records > 5 ? (
          <li>
            <Text size="xs" tone="subtle">
              …and {records - 5} more
            </Text>
          </li>
        ) : null}
      </ul>

      {fields.length > 0 ? (
        <Text size="xs" tone="subtle" className="mt-1.5">
          Fields: {fields.join(", ")}
        </Text>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="xs"
          variant="primary"
          loading={busy}
          onClick={() => {
            setBusy(true);
            approve(plan.id)
              .then(() => {
                setDone(true);
                toast.success("Applied.");
              })
              .catch((error: unknown) => toast.error(error))
              .finally(() => setBusy(false));
          }}
        >
          Approve
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setDone(true)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function linkFor(target: AiMutationTarget): string | null {
  if (target.kind === "document" && target.collectionSlug) {
    return `/c/${target.collectionSlug}/${target.id}`;
  }
  if (target.kind === "global" && target.collectionSlug) {
    return `/g/${target.collectionSlug}`;
  }
  if (target.kind === "media") return "/media";
  return null;
}

/**
 * Tells the assistant which screen is open.
 *
 * A hook rather than a prop, so a screen declares its own context next to the
 * data it already has. Everything in it is re-resolved on the server against
 * the configuration and re-read with the caller's permissions, so it is a
 * convenience for the editor and never an authority.
 *
 * Keyed on the context's own JSON rather than on a dependency list the caller
 * maintains. The list was the bug waiting to happen: a screen that depended
 * on `dirty.size` kept sending the first field it was told about when a
 * second one replaced it, and the assistant refuses to write a record whose
 * form is dirty — so the field it was not told about is exactly the one it
 * would have overwritten. The object is small, rebuilt from values the screen
 * already has, and `JSON.stringify` is cheaper than being wrong about it.
 *
 * `path` is part of the key because the provider drops the context on every
 * navigation: a screen whose context happens to be byte-identical on two
 * paths still has to re-register after that.
 */
export function usePageContext(context: AiPageContext): void {
  const { setPageContext } = useAssistant();
  const { path } = useRouter();
  const key = JSON.stringify(context);

  useEffect(() => {
    setPageContext(JSON.parse(key) as AiPageContext);
    return () => setPageContext(null);
    // Re-parsed from the key rather than closed over, so the effect cannot
    // register a context from a render the key no longer describes.
  }, [key, path, setPageContext]);
}

/**
 * Tells the assistant which tab of the screen is in front.
 *
 * Separate from `usePageContext` because it has a different owner. A document
 * with two rich-text fields is two writing surfaces, and the component that
 * draws that tab strip is not the screen that knows which record is open — so
 * "rewrite this section" is only answerable if both facts can be registered
 * independently. The same channel carries the settings tab and the media
 * library's status tab.
 */
export function usePageTab(tab: string | null): void {
  const { setPageTab } = useAssistant();
  const { path } = useRouter();

  useEffect(() => {
    setPageTab(tab);
    return () => setPageTab(null);
  }, [path, setPageTab, tab]);
}
