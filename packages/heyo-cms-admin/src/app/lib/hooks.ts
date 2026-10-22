import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Data loading, without a data-loading library.
 *
 * The panel's screens all want the same four things: the value, whether it is
 * still coming, what went wrong, and a way to ask again after a write. That
 * is this hook. Caching across screens is deliberately absent — an editor who
 * presses "back" after publishing should see the published row, not the one
 * that was cached before the write.
 */
export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Re-runs the loader. Returns when the new value has landed. */
  reload: () => Promise<void>;
  /** Replaces the value locally, for a write whose response is the new value. */
  set: (value: T) => void;
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        // An abort is this component moving on, not a failure to report.
        if (cancelled || controller.signal.aborted) return;
        setError(cause);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // The loader is held in a ref rather than listed here: it is rebuilt on
    // every render of the screen that owns it, and depending on its identity
    // would mean fetching on every render.
  }, [...dependencies, nonce]);

  const reload = useCallback(async () => {
    setNonce((value) => value + 1);
  }, []);

  return { data, error, loading, reload, set: setData };
}

/** Delays a fast-changing value — a search box against a real query. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * One keystroke, bound while the screen is mounted.
 *
 * `⌘S` is the only one the panel claims, and it claims it hard: the browser's
 * own "save this page" dialog over a half-written article is the worst
 * possible answer to that key in a CMS, so the default is prevented whether
 * or not the handler ends up doing anything.
 */
export function useHotkey(
  key: string,
  run: () => void,
  options: { meta?: boolean; enabled?: boolean } = {},
): void {
  const { meta = false, enabled = true } = options;
  const latest = useRef(run);
  latest.current = run;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (meta && !(event.metaKey || event.ctrlKey)) return;
      if (!meta && (event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (enabled) latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, meta, enabled]);
}

/**
 * Warns before leaving with unsaved changes.
 *
 * The panel does not autosave (stage 8 says so in as many words), so the
 * browser's own dialog is the backstop for the tab being closed. Navigation
 * inside the panel is guarded separately, where the question can be asked in
 * the panel's own words.
 */
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
