import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type { ComponentType } from "react";

/**
 * The slash menu, as a ProseMirror plugin plus a callback.
 *
 * TipTap's `Suggestion` utility owns the hard half — matching the trigger,
 * tracking the query as it is typed, and giving back the range to replace —
 * and deliberately owns none of the rendering. What is wired here is the
 * second half: instead of mounting a popup from inside the plugin (the usual
 * recipe, which drags in a positioning library and a second React root), the
 * plugin reports its state to a controller and React renders the list.
 *
 * One consequence worth stating: keyboard handling has to be answered from
 * the controller synchronously, because ProseMirror needs to know whether the
 * key was consumed before it does anything else with it.
 */

export interface SlashItem {
  /** Stable key and the word typed after the slash. */
  id: string;
  title: string;
  /** Visual grouping only; matching still considers every command. */
  group?: string;
  hint?: string;
  keywords: string[];
  /** The same glyph the toolbar uses, so the two lists read as one feature. */
  icon?: ComponentType<{ className?: string }>;
  run: (context: { editor: Editor; range: Range }) => void;
}

export interface SlashRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SlashState {
  open: boolean;
  items: SlashItem[];
  index: number;
  /** Where the trigger is on screen, for positioning the list. */
  rect: SlashRect | null;
  /**
   * Runs an item through the plugin.
   *
   * The range of the typed `/heading` belongs to the plugin, not to the
   * menu, so choosing an item means handing it back rather than editing the
   * document directly — that is what removes the trigger text along with the
   * insertion.
   */
  command: ((item: SlashItem) => void) | null;
}

export interface SlashController {
  update: (state: SlashState) => void;
  /** Returns true when the key belonged to the menu. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const closedSlashState: SlashState = {
  open: false,
  items: [],
  index: 0,
  rect: null,
  command: null,
};

export interface SlashOptions {
  items: () => SlashItem[];
  controller: { current: SlashController | null };
}

export function slashExtension(options: SlashOptions): Extension {
  return Extension.create({
    name: "heyoSlashMenu",

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          // A slash inside a word is a slash: `and/or` must not open a menu.
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => filterItems(options.items(), query),
          command: ({ editor, range, props }) => props.run({ editor, range }),
          render: () => ({
            onStart: (props) => {
              options.controller.current?.update({
                open: props.items.length > 0,
                items: props.items,
                index: 0,
                rect: props.clientRect?.() ?? null,
                command: props.command,
              });
            },
            onUpdate: (props) => {
              options.controller.current?.update({
                open: props.items.length > 0,
                items: props.items,
                index: 0,
                rect: props.clientRect?.() ?? null,
                command: props.command,
              });
            },
            onKeyDown: (props) =>
              options.controller.current?.onKeyDown(props.event) ?? false,
            onExit: () => {
              options.controller.current?.update(closedSlashState);
            },
          }),
        }),
      ];
    },
  });
}

function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const term = query.trim().toLowerCase();
  if (term === "") return items;
  return items.filter((item) =>
    [item.title, ...item.keywords].some((word) =>
      word.toLowerCase().includes(term),
    ),
  );
}
