/**
 * Finding a control by the words next to it.
 *
 * Shared by the DOM suites because the three ways a control can be labelled
 * are a property of the component library, not of any one test:
 *
 * - `<label for>` — a plain `<label>` the panel wrote itself.
 * - `aria-labelledby` — what heyo-ui's `Field` produces. Base UI points the
 *   control at the label's id rather than the label at the control's, which
 *   is equally correct and invisible to a `for` lookup.
 * - `aria-label` — the controls with no visible label, like the document
 *   title, which is the page's heading rather than a field.
 *
 * A test that knew only the first one would quietly stop finding half the
 * panel the day a field gained a description.
 */
export function findControl(
  container: ParentNode,
  label: string,
): Element | null {
  const wanted = label.toLowerCase();

  const element = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.trim().toLowerCase().startsWith(wanted),
  );

  if (element) {
    const forId = element.getAttribute("for");
    // Attribute form rather than `#id`: React's and Base UI's generated ids
    // contain characters that are legal in an id and awkward in a selector.
    if (forId) {
      const target = container.querySelector(`[id="${forId}"]`);
      if (target) return target;
    }

    const labelId = element.getAttribute("id");
    if (labelId) {
      const target = container.querySelector(`[aria-labelledby="${labelId}"]`);
      if (target) return target;
    }
  }

  return container.querySelector(`[aria-label="${label}"]`);
}
