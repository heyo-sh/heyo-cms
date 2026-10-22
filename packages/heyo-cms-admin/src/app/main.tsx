import type { PanelConfig } from "@heyo-sh/heyo-cms/types";
import { Code, Heading, Spinner, Text, Toaster } from "@heyo-sh/heyo-ui";
import * as React from "react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

import { App } from "./app";
import { ConfirmProvider } from "./components/confirm";
import { api, mount } from "./lib/api";
import { AssistantProvider } from "./lib/assistant";
import { loadPanelExtensions } from "./lib/extensions";
import { PanelProvider, type Session } from "./lib/panel";
import { RouterProvider } from "./lib/router";
import { SignIn } from "./screens/sign-in";

/**
 * Start-up: two requests, then one of two screens.
 *
 * `GET /panel` describes the deployment and `GET /auth/session` says who is
 * asking. Both are needed before anything can be drawn — the sign-in screen
 * itself is rendered from the configuration, since the methods it offers are
 * the methods the handler registered — and both are cheap, so they are made
 * in parallel and the panel waits for them rather than flashing a skeleton
 * of a layout it might not be allowed to show.
 *
 * A failure here is almost always one of two things: the panel is mounted
 * somewhere the API is not, or the database has not been migrated. The error
 * screen says both, because the browser's console will not.
 */
function Boot() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; config: PanelConfig; session: Session }
    | { kind: "failed"; error: unknown }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<PanelConfig>("/panel"),
      api
        .get<Session>("/auth/session")
        // Never a reason not to render: an unauthenticated caller is the
        // normal first visit, and the endpoint answers `{ actor: null }`
        // rather than 401 for exactly that reason.
        .catch(() => ({ actor: null, user: null }) as Session),
    ])
      .then(async ([config, session]) => {
        // Plugin scripts before the first render: a field control that
        // registers late would mean the form draws the fallback and then
        // swaps it, which looks like a bug and loses focus.
        await loadPanelExtensions(config, { react: React });
        if (!cancelled) setState({ kind: "ready", config, session });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  if (state.kind === "failed") {
    const message =
      state.error instanceof Error ? state.error.message : String(state.error);
    return (
      <div className="mx-auto max-w-md p-10">
        <Heading level={1} className="text-lg">
          The panel cannot start
        </Heading>
        <Text tone="subtle" className="mt-2">
          {message}
        </Text>
        <Text tone="subtle" className="mt-3">
          It asked <Code>{mount.basePath}/panel</Code>. Either the handler is
          mounted somewhere else — check <Code>basePath</Code> — or the database
          has no schema yet, in which case run the migrations.
        </Text>
      </div>
    );
  }

  if (!state.session.actor) {
    return (
      <>
        <SignIn config={state.config} />
        <Toaster timeout={5000} />
      </>
    );
  }

  return (
    <PanelProvider config={state.config} initialSession={state.session}>
      <RouterProvider>
        {/*
         * Above `App` and inside the router, which is the only placement that
         * works: the assistant needs the current path to describe where the
         * editor is, and its conversation has to survive every navigation
         * that path describes. Inside `App` it would be unmounted by the
         * first click on a link.
         */}
        <AssistantProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </AssistantProvider>
      </RouterProvider>
      <Toaster timeout={5000} />
    </PanelProvider>
  );
}

const container = document.getElementById("heyo-cms-root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Boot />
    </StrictMode>,
  );
}
