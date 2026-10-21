import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { mount } from "./api";

/**
 * The router, which is thirty lines of `history`.
 *
 * The panel has eight screens and one mount point, and a routing library
 * would be the second-largest dependency in the bundle after the editor. The
 * handler already serves the shell for any path under the panel (the SPA
 * fallback in `routes/admin.ts`), so deep links work; all that is needed here
 * is "which path are we on" and "go to this one without a reload".
 *
 * Paths in this file are always *panel* paths — `/posts/doc_1` — with the
 * mount prefix added on the way out and stripped on the way in. Nothing in a
 * screen should ever have to know where the panel is mounted.
 */

/**
 * "May I leave this screen?"
 *
 * Answered by whichever screen is holding unsaved work. `true` lets the
 * navigation happen, `false` cancels it, and a promise is the normal case —
 * the screen is asking the editor in a dialog of its own words.
 */
type Blocker = () => boolean | Promise<boolean>;

interface NavigateOptions {
  replace?: boolean;
  /**
   * Goes without asking the guard.
   *
   * For the navigations that *are* the save: a document that has just been
   * created has nothing left to lose, but the state saying so has not
   * re-rendered yet, so the guard would ask whether to discard work that is
   * already in the database.
   */
  force?: boolean;
}

interface RouterValue {
  path: string;
  query: URLSearchParams;
  navigate: (path: string, options?: NavigateOptions) => void;
  /** Registers a guard for as long as the screen is mounted. */
  block: (blocker: Blocker) => () => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => currentLocation());
  const blocker = useRef<Blocker | null>(null);

  useEffect(() => {
    const onPop = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const block = useCallback((next: Blocker) => {
    blocker.current = next;
    return () => {
      if (blocker.current === next) blocker.current = null;
    };
  }, []);

  const navigate = useCallback(
    (path: string, options: NavigateOptions = {}) => {
      const go = () => {
        const next = `${mount.panelPath}${path === "/" ? "" : path}`;
        if (options.replace) window.history.replaceState({}, "", next);
        else window.history.pushState({}, "", next);
        setLocation(currentLocation());
        window.scrollTo(0, 0);
      };

      const ask = blocker.current;
      if (!ask || options.force) {
        if (options.force) blocker.current = null;
        go();
        return;
      }

      // The guard belongs to the screen being left, so it is dropped before
      // the navigation rather than after: a screen that answered "yes, leave"
      // must not be asked again by its own unmount.
      const answer = ask();
      if (answer === true) {
        blocker.current = null;
        go();
        return;
      }
      if (answer === false) return;
      void answer.then((allowed) => {
        if (!allowed) return;
        blocker.current = null;
        go();
      });
    },
    [],
  );

  const value = useMemo<RouterValue>(
    () => ({ path: location.path, query: location.query, navigate, block }),
    [location, navigate, block],
  );

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter outside RouterProvider");
  return value;
}

/**
 * Guards every in-panel navigation while `when` is true.
 *
 * The browser's own `beforeunload` covers the tab closing (`useUnsavedWarning`
 * does that); this covers the nine times out of ten it is a click on the
 * sidebar, where the question can be asked in the panel's words and the
 * answer can be "save first".
 */
export function useNavigationBlock(when: boolean, ask: () => Promise<boolean>) {
  const { block } = useRouter();
  const latest = useRef(ask);
  latest.current = ask;

  useEffect(() => {
    if (!when) return;
    return block(() => latest.current());
  }, [when, block]);
}

function currentLocation(): { path: string; query: URLSearchParams } {
  const pathname = window.location.pathname;
  const relative = pathname.startsWith(mount.panelPath)
    ? pathname.slice(mount.panelPath.length)
    : pathname;
  return {
    path: relative === "" ? "/" : relative,
    query: new URLSearchParams(window.location.search),
  };
}

export interface LinkProps extends Omit<ComponentProps<"a">, "href"> {
  to: string;
}

/**
 * An anchor that is a real anchor.
 *
 * `href` is written out so middle-click, "open in new tab" and the status bar
 * all behave; the click handler only takes over the plain left click, which
 * is the one that should not reload the application.
 *
 * Everything else is forwarded, including the `ref` and the `className` that
 * heyo-ui's `render` prop hands down — `<Sidebar.MenuButton render={<Link
 * to="/media" />}>` has to end up as one anchor styled like a menu row, not
 * as a button wrapping a link.
 */
export function Link({ to, onClick, children, ...props }: LinkProps) {
  const { navigate } = useRouter();
  return (
    <a
      href={`${mount.panelPath}${to === "/" ? "" : to}`}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    >
      {children}
    </a>
  );
}
