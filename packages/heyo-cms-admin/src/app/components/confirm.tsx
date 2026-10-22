import { Button, Dialog, Text } from "@heyo-sh/heyo-ui";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ErrorNote } from "./chrome";

/**
 * "Are you sure?", asked properly.
 *
 * `window.confirm` was doing this job and doing three things wrong: it is
 * styled by the browser rather than by the panel, it cannot say what will
 * actually happen beyond one line of text, and it blocks the main thread so
 * the answer cannot carry the request — which is why a slow delete used to
 * look like nothing had happened.
 *
 * This is the same prompt as a promise. A screen awaits it:
 *
 * ```ts
 * const ok = await confirm({
 *   title: "Move this document to the trash?",
 *   description: "It can be restored from the trash for 30 days.",
 *   confirmLabel: "Move to trash",
 *   destructive: true,
 * });
 * ```
 *
 * …or hands over the work itself, in which case the dialog stays up with the
 * button spinning until the request settles and shows the server's refusal in
 * place rather than as a toast over a screen that already moved on:
 *
 * ```ts
 * await confirm({ …, run: () => api.delete(`/posts/${id}`) });
 * ```
 *
 * One dialog instance for the whole panel, so nothing has to hold `open`
 * state for a question it asks once.
 */

export interface ConfirmRequest {
  title: ReactNode;
  description?: ReactNode;
  /** The exact things that will happen. Rendered as a list, not prose. */
  consequences?: ReactNode[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red button, for anything that loses data. */
  destructive?: boolean;
  /**
   * The work itself.
   *
   * Given one, the dialog does not close until it resolves, and a rejection
   * is shown inside the dialog: the editor is still looking at it, which is
   * the only place the message is certain to be read.
   */
  run?: () => Promise<unknown>;
}

type Ask = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    resolver.current?.(answer);
    resolver.current = null;
    setRequest(null);
    setBusy(false);
    setError(null);
  }, []);

  const ask = useCallback<Ask>((next) => {
    setError(null);
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      // A second question while one is open answers the first with "no"
      // rather than dropping its promise on the floor.
      resolver.current?.(false);
      resolver.current = resolve;
    });
  }, []);

  const confirm = async () => {
    if (!request) return;
    if (!request.run) {
      settle(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.run();
      settle(true);
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  };

  const value = useMemo(() => ask, [ask]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={request !== null}
        // While the work is in flight there is nothing to cancel: closing the
        // dialog would hide a request that is still going to land.
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open && !busy) settle(false);
        }}
      >
        <Dialog.Content size="sm">
          <Dialog.Header>
            <Dialog.Title className="min-w-0 truncate">
              {request?.title}
            </Dialog.Title>
            {request?.description ? (
              <Dialog.Description>{request.description}</Dialog.Description>
            ) : null}
          </Dialog.Header>

          {request?.consequences?.length || error ? (
            <Dialog.Body className="space-y-3">
              {request?.consequences?.length ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {request.consequences.map((line, index) => (
                    <li key={index} className="flex gap-2">
                      <span
                        aria-hidden
                        className="mt-[0.4375rem] size-1 shrink-0 rounded-full bg-heyo-inactive"
                      />
                      <Text size="sm" tone="subtle" className="min-w-0 flex-1">
                        {line}
                      </Text>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ErrorNote error={error} />
            </Dialog.Body>
          ) : null}

          <Dialog.Footer>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => settle(false)}
            >
              {request?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={request?.destructive ? "destructive" : "primary"}
              loading={busy}
              onClick={() => void confirm()}
            >
              {request?.confirmLabel ?? "Confirm"}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  const value = useContext(ConfirmContext);
  if (!value) throw new Error("useConfirm outside ConfirmProvider");
  return value;
}
