// Keep the starter and the CMS panel on the same saved light/dark preference.
(() => {
  const key = "heyo-cms:theme";
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
      document.documentElement.dataset.mode = saved;
    }
  } catch {
    // Private browsing can disable storage; the system preference still works.
  }

  document.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-theme-toggle]")
    )
      return;
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.mode = next;
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Storage is optional. */
    }
  });
})();
