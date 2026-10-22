import { toast as heyo } from "@heyo-sh/heyo-ui";
import type { ReactNode } from "react";

/**
 * heyo-ui's toasts, plus the one thing a CMS panel needs on top of them.
 *
 * `error()` takes whatever was thrown rather than a string, because every
 * call site in this panel is a `catch` and the useful text is the server's.
 * Every notification follows the root toaster's timeout, including errors:
 * the error is still dismissible immediately, but never stays over the UI.
 */
export const toast = {
  success: (message: ReactNode) => heyo.success(message),
  info: (message: string) => heyo.info(message),
  warning: (message: string) => heyo.warning(message),
  error: (error: unknown) =>
    heyo.error(
      error instanceof Error ? error.message : String(error ?? "Failed."),
    ),
};
