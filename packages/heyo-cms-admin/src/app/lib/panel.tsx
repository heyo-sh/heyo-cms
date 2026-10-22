import type { Actor, CmsUser, PanelConfig } from "@heyo-sh/heyo-cms/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, mount } from "./api";

/**
 * What every screen needs: the deployment, the caller, and the language.
 *
 * All three are answered by two requests made once, at start-up —
 * `GET /panel` and `GET /auth/session` — and held here rather than re-fetched
 * per screen. The configuration cannot change while the tab is open (it is a
 * deployment, not a document), and the session only changes when this file
 * changes it.
 */

export interface Session {
  actor: Actor | null;
  user: CmsUser | null;
}

interface PanelValue {
  config: PanelConfig;
  session: Session;
  reloadSession: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The language being edited. One choice for the whole panel. */
  locale: string;
  setLocale: (locale: string) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  /** Wildcard permission check, with no RBAC meaning "anyone signed in". */
  can: (permission: string) => boolean;
}

const PanelContext = createContext<PanelValue | null>(null);

const localeKey = "heyo-cms:locale";
const themeKey = "heyo-cms:theme";

export function PanelProvider({
  config,
  initialSession,
  children,
}: {
  config: PanelConfig;
  initialSession: Session;
  children: ReactNode;
}) {
  const [session, setSession] = useState(initialSession);
  const [locale, setLocaleState] = useState(() => {
    const stored = window.localStorage.getItem(localeKey);
    const known = config.i18n.locales.some((entry) => entry.code === stored);
    return stored && known ? stored : config.i18n.defaultLocale;
  });
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    // The shell puts this attribute on `<html>` before CSS loads. Reuse it so
    // React never briefly resolves a different mode after a hard refresh.
    const painted = document.documentElement.getAttribute("data-mode");
    if (painted === "light" || painted === "dark") return painted;
    try {
      const stored = window.localStorage.getItem(themeKey);
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // Storage can be disabled; the OS preference remains a safe fallback.
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  // heyo-ui resolves both colour modes through `light-dark()`, so the whole
  // panel follows one attribute and no component carries a `dark:` variant.
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const reloadSession = useCallback(async () => {
    setSession(await api.get<Session>("/auth/session"));
  }, []);

  const value = useMemo<PanelValue>(() => {
    const permissions = session.actor?.permissions ?? [];
    return {
      config,
      session,
      reloadSession,
      signOut: async () => {
        await api.post("/auth/sign-out");
        // A full reload rather than a state change: signing out should leave
        // nothing of the previous editor's documents in memory or on screen.
        window.location.href = mount.panelPath;
      },
      locale,
      setLocale: (next: string) => {
        window.localStorage.setItem(localeKey, next);
        setLocaleState(next);
      },
      theme,
      toggleTheme: () => {
        const next = theme === "dark" ? "light" : "dark";
        try {
          window.localStorage.setItem(themeKey, next);
        } catch {
          // A blocked storage area must not make the visible toggle fail.
        }
        setTheme(next);
      },
      can: (permission: string) => {
        if (!session.actor) return false;
        // Without `rbac` the engine treats an authenticated caller as
        // allowed and decides the rest per collection, so the panel must not
        // invent a stricter rule than the server applies.
        if (!config.rbac.enabled) return true;
        return permissions.some((pattern) => grants(pattern, permission));
      },
    };
  }, [config, session, reloadSession, locale, theme]);

  return (
    <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
  );
}

export function usePanel(): PanelValue {
  const value = useContext(PanelContext);
  if (!value) throw new Error("usePanel outside PanelProvider");
  return value;
}

/**
 * `posts:*` against `posts:update`.
 *
 * Twelve lines of the engine's grammar, copied deliberately: importing
 * `permits()` from `@heyo-sh/heyo-cms` would pull the configuration builder,
 * zod and the engine into a browser bundle to answer a string question. The
 * answer is advisory anyway — it decides whether a button is drawn, never
 * whether a write is allowed, which the server decides again regardless.
 */
function grants(pattern: string, required: string): boolean {
  if (pattern === "*") return true;
  const [patternResource = "*", patternAction = "*"] = split(pattern);
  const [resource = "*", action = "*"] = split(required);
  return (
    (patternResource === "*" || patternResource === resource) &&
    (patternAction === "*" || patternAction === action)
  );
}

function split(permission: string): [string, string] {
  const index = permission.indexOf(":");
  if (index === -1) return [permission, "*"];
  return [permission.slice(0, index), permission.slice(index + 1)];
}
