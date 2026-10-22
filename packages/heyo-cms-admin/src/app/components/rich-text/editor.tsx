import type { MediaDocument } from "@heyo-sh/heyo-cms/types";
import {
  Button,
  Dropdown,
  Input,
  ScrollArea,
  Separator,
  Spinner,
  Text,
  Tooltip,
  cn,
} from "@heyo-sh/heyo-ui";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronDown,
  IconLetterT,
  IconLink,
  IconPhoto,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import type { Editor, Extensions, Range } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { altText, isImage, previewUrl } from "../../lib/media";
import { usePanel } from "../../lib/panel";
import { sameValue } from "../../lib/value";
import { MediaPicker } from "../media-field";
import { LinkPopover } from "./link-popover";
import { pluginNodeExtensions } from "./plugin-nodes";
import { closedSlashState, slashExtension, type SlashController, type SlashItem, type SlashState } from "./slash"; // prettier-ignore
import {
  blockActions,
  imageAction,
  insertActions,
  listActions,
  markActions,
  tableActions,
  type EditorAction,
} from "./toolbar-items";

/**
 * The rich-text field: TipTap v3, every control from heyo-ui, and no autosave.
 *
 * The stored value is the ProseMirror document — JSON, not HTML — because
 * that is what `richText()` validates and what the serialisers in
 * `@heyo-sh/heyo-cms/editor` turn into HTML or Markdown on the way out. The
 * editor therefore reports JSON and nothing here ever touches `getHTML()`.
 *
 * **Nothing is saved while typing.** The document form holds the value and
 * the editor pushes changes into it; the write happens when somebody presses
 * Save. An editor that saves on a keystroke is an editor that publishes a
 * half-written sentence to an audience.
 *
 * Four surfaces, and each one answers a different question:
 *
 * - **The toolbar** is what is possible. Always visible, so nothing has to be
 *   discovered by selecting text first.
 * - **The bubble menu** is what applies to *this* selection, where the eye
 *   already is.
 * - **The table and image menus** are what applies to the node under the
 *   caret — a table gets rows and columns, an image gets its alternative text.
 * - **The slash menu** is insertion by keyboard, which is how a writer who
 *   has both hands on the keys actually adds a heading.
 *
 * Images carry `mediaId` as well as `src`. That attribute is the whole of the
 * media lifecycle for rich text: the engine counts a file as used when it
 * finds the id anywhere in the stored body, and a bare URL is not a
 * reference.
 */

const PanelImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-media-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.mediaId
            ? { "data-media-id": String(attributes.mediaId) }
            : {},
      },
    };
  },
});

export interface RichTextEditorProps {
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
  disabled?: boolean;
  placeholder?: string;
  /** `richText({ nodes })`: the node names this field allows. */
  nodes?: string[];
  /**
   * `boxed` sits inside a form, framed like any other control.
   * `page` fills the editing column: no frame, a sticky toolbar and prose
   * measured to a comfortable line length. The document screen uses it when
   * a collection has a body, which is the layout a writer expects.
   */
  variant?: "boxed" | "page";
  /** Rendered at the right of the toolbar — the field's AI menu, usually. */
  toolbarExtra?: React.ReactNode;
}

export function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
  nodes,
  variant = "boxed",
  toolbarExtra,
}: RichTextEditorProps) {
  const { config, locale } = usePanel();
  /**
   * What the form currently holds.
   *
   * The editor reports a change only when its document differs from this,
   * which is the difference between an edit and ProseMirror tidying up after
   * itself. Written on every render because the form owns the value.
   */
  const held = useRef<Record<string, unknown> | null>(value ?? null);
  held.current = value ?? null;
  const [picking, setPicking] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [slash, setSlash] = useState<SlashState>(closedSlashState);
  const slashState = useRef(slash);
  slashState.current = slash;
  const controller = useRef<SlashController | null>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slashMenuId = useId();
  const allows = useCallback(
    (node: string) => nodes === undefined || nodes.includes(node),
    [nodes],
  );

  // Half a megabyte of shortcodes, fetched after the field is already
  // usable. A failure leaves the editor working without them.
  const [emoji, setEmoji] = useState<Extensions>([]);
  useEffect(() => {
    let cancelled = false;
    void import("./emoji")
      .then((module) => {
        if (!cancelled) setEmoji([module.emojiExtension()]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const picture = useMemo(() => imageAction(() => setPicking(true)), []);

  /** The whole vocabulary, minus whatever the field refused. */
  const vocabulary = useMemo(() => {
    const permitted = (entry: EditorAction) => allows(entry.id);
    return {
      blocks: blockActions.filter(permitted),
      marks: markActions.filter(permitted),
      lists: listActions.filter(permitted),
      inserts: [
        ...insertActions,
        ...(config.media.enabled ? [picture] : []),
      ].filter(permitted),
    };
  }, [allows, config.media.enabled, picture]);

  // The contextual bubble keeps only the two inserts that naturally follow a
  // text selection. The full insertion vocabulary remains in the toolbar and
  // slash menu, rather than turning the bubble into a second toolbar.
  const selectionInserts = vocabulary.inserts.filter(
    (entry) => entry.id === "image" || entry.id === "table",
  );

  const items = useCallback((): SlashItem[] => {
    const group = (label: string, entries: EditorAction[]) =>
      entries.map((entry) => ({
        id: entry.id,
        title: entry.label,
        group: label,
        keywords: entry.keywords ?? [],
        icon: entry.icon,
        run: ({
          editor: instance,
          range,
        }: {
          editor: Editor;
          range: Range;
        }) => {
          instance.chain().focus().deleteRange(range).run();
          entry.run(instance);
        },
      }));
    return [
      ...group(
        "Text",
        vocabulary.blocks.filter((entry) => entry.id !== "paragraph"),
      ),
      ...group("Lists", vocabulary.lists),
      ...group("Insert", vocabulary.inserts),
    ];
  }, [vocabulary]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        // Opening a link while editing navigates away from unsaved work.
        link: { openOnClick: false, autolink: true },
        heading: { levels: [1, 2, 3, 4] },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Write something, or press / for blocks",
      }),
      TableKit.configure({ table: { resizable: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      PanelImage.configure({ inline: false }),
      // Shortcodes and emoticons, no second popup: `:tada:` becomes 🎉 as it
      // is typed, which is the part of emoji support people actually use.
      ...emoji,
      // Nodes a plugin registered. Without them ProseMirror would drop a
      // node it does not know, and the next Save would make the loss
      // permanent — the document is the editor's output, not the file's.
      ...pluginNodeExtensions(config.editor),
      slashExtension({ items, controller }),
    ],
    [items, placeholder, emoji, config.editor],
  );

  const editor = useEditor(
    {
      extensions,
      editable: disabled !== true,
      content: value ?? null,
      editorProps: {
        attributes: {
          class: cn(
            "heyo-prose focus:outline-none",
            // The page variant is measured and padded by its wrapper, which
            // is also what the title input and the toolbar are aligned to.
            variant === "page" ? "min-h-[18rem] pb-24" : "min-h-40 px-3 py-2",
          ),
        },
        // The editor accepts deliberate commands and the media picker, not
        // native drops. A native drop can reorder prose or introduce a file
        // without its media reference, both of which are surprising writes.
        handleDrop: () => true,
        handleDOMEvents: {
          dragstart: (_view, event) => {
            event.preventDefault();
            return true;
          },
          dragover: (_view, event) => {
            event.preventDefault();
            return true;
          },
          drop: (_view, event) => {
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: instance }) => {
        const next = instance.isEmpty
          ? null
          : (instance.getJSON() as Record<string, unknown>);
        // ProseMirror reports an update for its own normalisation too — the
        // editor is rebuilt once when the emoji table finishes loading, and
        // parsing a stored document fills in default attributes. Both arrive
        // here as "the document changed" and neither is an edit. Reporting
        // them marked every document unsaved the moment it opened, which
        // made the badge, the Save button and the leave-confirmation all lie.
        //
        // `sameValue`, not `JSON.stringify`: the body makes a round trip
        // through the database between the save and the next render of this
        // field, and a JSON column is free to hand the object back with its
        // keys in another order. Two spellings of one document.
        if (sameValue(next, held.current)) return;
        held.current = next;
        onChange(next);
      },
      immediatelyRender: false,
    },
    [extensions, variant],
  );

  // The form owns the value: a locale switch or a reload replaces it under
  // the editor, and the editor has to follow without wiping what is open.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getJSON();
    const next = value ?? { type: "doc", content: [] };
    if (sameValue(current, next)) return;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  // `false`: TipTap's `setEditable` emits an `update` whether or not the
  // document changed — it has no transaction to report, so it invents one
  // from `state.tr`. This effect runs on every mount, which meant every
  // field that opened announced an edit nobody had made; whatever the
  // guard in `onUpdate` could not explain away then became an unsaved
  // change in a document that had just been loaded or just been saved.
  useEffect(() => {
    editor?.setEditable(disabled !== true, false);
  }, [editor, disabled]);

  // Written on every render rather than once: the handlers close over the
  // latest state, and the plugin only ever reads through the ref.
  useEffect(() => {
    controller.current = {
      update: setSlash,
      onKeyDown: (event) => {
        const state = slashState.current;
        if (!state.open || state.items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSlash((current) => ({
            ...current,
            index: (current.index + 1) % current.items.length,
          }));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSlash((current) => ({
            ...current,
            index:
              (current.index - 1 + current.items.length) % current.items.length,
          }));
          return true;
        }
        if (event.key === "Tab") {
          setSlash((current) => ({
            ...current,
            index: event.shiftKey
              ? (current.index - 1 + current.items.length) %
                current.items.length
              : (current.index + 1) % current.items.length,
          }));
          return true;
        }
        if (event.key === "Enter") {
          const chosen = state.items[state.index];
          if (!chosen || !state.command) return false;
          state.command(chosen);
          return true;
        }
        return event.key === "Escape";
      },
    };
  });

  // TipTap calls the suggestion renderer when text changes, not when a
  // surrounding page scrolls. Keep the floating list attached to its slash
  // through a scroll, resize or browser zoom just as Paragraph's editor does.
  useEffect(() => {
    if (!editor || !slash.open) return;
    const reposition = () => {
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      setSlash((current) =>
        current.open ? { ...current, rect: coords } : current,
      );
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [editor, slash.open]);

  // A selected command must stay visible while keyboard navigation crosses a
  // long slash list. Native scrollIntoView finds the ScrollArea viewport.
  useEffect(() => {
    if (!slash.open || slash.index < 0) return;
    slashItemRefs.current[slash.index]?.scrollIntoView({ block: "nearest" });
  }, [slash.index, slash.items, slash.open]);

  const insertImage = (file: MediaDocument, replace: boolean) => {
    if (!editor || !isImage(file)) return;
    const attributes = {
      src: previewUrl(file, config.media.variants, "card"),
      alt: altText(file, locale),
      // The reference the engine counts. Without it the file is orphaned
      // the moment nothing else points at it.
      mediaId: file.id,
    } as { src: string; alt: string; mediaId: string };

    if (replace) {
      editor.chain().focus().updateAttributes("image", attributes).run();
      return;
    }
    editor.chain().focus().setImage(attributes).run();
  };

  if (!editor) {
    return (
      <div
        className={cn(
          "flex w-full items-center justify-center",
          variant === "page" ? "h-64" : "h-32 rounded-lg",
        )}
      >
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col",
        variant === "boxed" &&
          "min-h-0 rounded-lg bg-heyo-base ring-1 ring-heyo-line",
        disabled && "opacity-60",
      )}
    >
      <Toolbar
        editor={editor}
        vocabulary={vocabulary}
        variant={variant}
        extra={toolbarExtra}
      />

      {/*
       * Marks, where the eye already is.
       *
       * `z-40` on every bubble, and it is not decoration. TipTap appends the
       * menu to the editor's own parent with nothing but `position:absolute`
       * on it, so it paints as an auto-layer element — which loses to *any*
       * positive layer in the same stacking context, including the toolbar's
       * `z-20`. A selection on the first line of the document opened its
       * bubble behind the toolbar. 40 clears the toolbar and the page bar
       * (`z-30`) and stays under heyo-ui's overlay scale (`z-50` dialogs,
       * `z-[60]` popups), so the media picker a bubble opens still covers the
       * bubble that opened it.
       */}
      <BubbleMenu
        className="z-40"
        editor={editor}
        pluginKey="heyoMarkBubble"
        updateDelay={0}
        shouldShow={({ editor: instance, from, to }) =>
          instance.isEditable &&
          from !== to &&
          !instance.isActive("image") &&
          !instance.isActive("table") &&
          !instance.isActive("codeBlock")
        }
      >
        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-heyo-overlay px-2 py-1.5 shadow-lg ring-1 ring-heyo-line">
          <TurnIntoMenu editor={editor} blocks={vocabulary.blocks} compact />
          {vocabulary.marks.length > 0 ? (
            <Separator orientation="vertical" className="mx-0.5 h-5" />
          ) : null}
          {vocabulary.marks.map((entry) => (
            <ActionButton key={entry.id} editor={editor} action={entry} />
          ))}
          <LinkPopover
            editor={editor}
            trigger={<LinkButton editor={editor} />}
          />
          {selectionInserts.length > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-5" />
              {selectionInserts.map((entry) => (
                <ActionButton key={entry.id} editor={editor} action={entry} />
              ))}
            </>
          ) : null}
        </div>
      </BubbleMenu>

      {/* Rows and columns, only while the caret is inside a table. */}
      <BubbleMenu
        className="z-40"
        editor={editor}
        pluginKey="heyoTableBubble"
        updateDelay={0}
        shouldShow={({ editor: instance }) =>
          instance.isEditable && instance.isActive("table")
        }
        options={{ placement: "top" }}
      >
        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-heyo-overlay px-2 py-1.5 shadow-lg ring-1 ring-heyo-line">
          {tableActions.map((entry) => (
            <ActionButton key={entry.id} editor={editor} action={entry} />
          ))}
        </div>
      </BubbleMenu>

      {/* Everything an image is, which is mostly its alternative text. */}
      <BubbleMenu
        className="z-40"
        editor={editor}
        pluginKey="heyoImageBubble"
        updateDelay={0}
        shouldShow={({ editor: instance }) =>
          instance.isEditable && instance.isActive("image")
        }
        options={{ placement: "bottom" }}
      >
        <ImagePanel
          editor={editor}
          onReplace={() => {
            setReplacing(true);
            setPicking(true);
          }}
        />
      </BubbleMenu>

      {/* One scroller per column: the page variant is a block inside the
          screen's own scroll area, not a second one nested in it. */}
      <div className="min-h-0 flex-1">
        <div
          className={
            variant === "page"
              ? "mx-auto w-full max-w-3xl px-6 pt-8"
              : undefined
          }
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      {slash.open && slash.rect ? (
        <SlashMenu
          id={slashMenuId}
          state={slash}
          itemRefs={slashItemRefs}
          onSelect={(entry) => slash.command?.(entry)}
          onHighlight={(index) =>
            setSlash((current) => ({ ...current, index }))
          }
        />
      ) : null}

      <MediaPicker
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) setReplacing(false);
        }}
        accept="image/*"
        onPick={(file: MediaDocument) => {
          setPicking(false);
          insertImage(file, replacing);
          setReplacing(false);
        }}
      />
    </div>
  );
}

/**
 * React owns the slash surface; Suggestion owns matching and the replacement
 * range. Keeping this list in a real scroll container lets selection follow
 * ArrowUp/ArrowDown even after it moves below the visible commands.
 */
function SlashMenu({
  id,
  state,
  itemRefs,
  onSelect,
  onHighlight,
}: {
  id: string;
  state: SlashState;
  itemRefs: { current: Array<HTMLButtonElement | null> };
  onSelect: (item: SlashItem) => void;
  onHighlight: (index: number) => void;
}) {
  if (!state.rect) return null;
  const { left, top, transform } = slashMenuPosition(state.rect);
  const activeId = `${id}-${state.index}`;
  const groups = state.items.reduce<
    Array<{
      label: string | undefined;
      items: Array<{ item: SlashItem; index: number }>;
    }>
  >((result, item, index) => {
    const last = result.at(-1);
    if (last && last.label === item.group) {
      last.items.push({ item, index });
    } else {
      result.push({ label: item.group, items: [{ item, index }] });
    }
    return result;
  }, []);

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Insert a block"
      aria-activedescendant={activeId}
      className="fixed z-50 w-64 max-w-[calc(100vw-1rem)]"
      style={{ left, top, transform }}
    >
      <ScrollArea
        maxHeight="18rem"
        className="overflow-hidden rounded-xl bg-heyo-overlay shadow-lg ring-1 ring-heyo-line"
        viewportClassName="p-1"
      >
        {groups.map((group, groupIndex) => (
          <div key={`${group.label ?? "commands"}-${groupIndex}`}>
            {groupIndex > 0 ? (
              <div className="mx-1 my-1 h-px bg-heyo-hairline" />
            ) : null}
            {group.label ? (
              <div className="px-2 py-1 text-xs font-medium text-heyo-subtle">
                {group.label}
              </div>
            ) : null}
            {group.items.map(({ item: entry, index }) => {
              const Icon = entry.icon;
              const active = index === state.index;
              return (
                <button
                  key={entry.id}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  id={`${id}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  // `mousedown` rather than `click`: a click first blurs the
                  // editor, and the insertion range goes with the selection.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(entry);
                  }}
                  onMouseEnter={() => onHighlight(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-heyo-tint text-heyo-strong"
                      : "text-heyo-default hover:bg-heyo-tint",
                  )}
                >
                  {Icon ? (
                    <Icon className="size-4 shrink-0 text-heyo-subtle" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                </button>
              );
            })}
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}

function slashMenuPosition(rect: NonNullable<SlashState["rect"]>) {
  const width = 16 * 16;
  const gutter = 8;
  const maxHeight = 18 * 16;
  const openAbove =
    rect.bottom + gutter + maxHeight > window.innerHeight &&
    rect.top - gutter > maxHeight;
  return {
    left: Math.max(
      gutter,
      Math.min(rect.left, window.innerWidth - width - gutter),
    ),
    top: openAbove ? rect.top - gutter : rect.bottom + gutter,
    ...(openAbove ? { transform: "translateY(-100%)" } : {}),
  };
}

interface Vocabulary {
  blocks: EditorAction[];
  marks: EditorAction[];
  lists: EditorAction[];
  inserts: EditorAction[];
}

/** The always-visible row: what is possible, before anything is selected. */
function Toolbar({
  editor,
  vocabulary,
  variant,
  extra,
}: {
  editor: Editor;
  vocabulary: Vocabulary;
  variant: "boxed" | "page";
  extra?: React.ReactNode;
}) {
  const history = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      undo: instance.can().undo(),
      redo: instance.can().redo(),
    }),
  });

  return (
    <div
      className={cn(
        variant === "boxed"
          ? "flex shrink-0 flex-wrap items-center gap-1 border-b border-heyo-hairline px-2 py-1.5"
          : // Full-bleed bar, flush left. The prose is centred because a
            // measure is what makes it readable; a toolbar has no measure,
            // and centring it on the column only moved the controls away
            // from the edge the eye returns to — and away from the panel's
            // other bars, which all start at the left. The blur is what lets
            // a paragraph scroll under it.
            "sticky top-0 z-20 border-b border-heyo-hairline bg-heyo-canvas/80 backdrop-blur-md",
      )}
    >
      <div
        className={cn(
          variant === "page"
            ? // `min-h-12`: one height for every strip in the panel — the page
              // bar, the sidebar's search row, the fields pane's own bar.
              // `min-`, not `h-`, because the row still wraps on a narrow
              // column and a fixed height would spill the second line out.
              "flex min-h-12 w-full flex-wrap items-center gap-1 px-3 py-2"
            : "contents",
        )}
      >
        <Tooltip content="Undo">
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            icon={IconArrowBackUp}
            aria-label="Undo"
            disabled={!history?.undo}
            onClick={() => editor.chain().focus().undo().run()}
          />
        </Tooltip>
        <Tooltip content="Redo">
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            icon={IconArrowForwardUp}
            aria-label="Redo"
            disabled={!history?.redo}
            onClick={() => editor.chain().focus().redo().run()}
          />
        </Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <TurnIntoMenu editor={editor} blocks={vocabulary.blocks} />

        {vocabulary.marks.length > 0 ? (
          <>
            <Separator orientation="vertical" className="mx-1 h-5" />
            {vocabulary.marks.map((entry) => (
              <ActionButton key={entry.id} editor={editor} action={entry} />
            ))}
            <LinkPopover
              editor={editor}
              trigger={<LinkButton editor={editor} />}
            />
          </>
        ) : null}

        {vocabulary.lists.length > 0 ? (
          <>
            <Separator orientation="vertical" className="mx-1 h-5" />
            {vocabulary.lists.map((entry) => (
              <ActionButton key={entry.id} editor={editor} action={entry} />
            ))}
          </>
        ) : null}

        {vocabulary.inserts.length > 0 ? (
          <>
            <Separator orientation="vertical" className="mx-1 h-5" />
            {vocabulary.inserts.map((entry) => (
              <ActionButton key={entry.id} editor={editor} action={entry} />
            ))}
          </>
        ) : null}

        {extra ? (
          <>
            <span className="flex-1" />
            {extra}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** "Turn into": the block the caret is in, as a menu rather than five buttons. */
function TurnIntoMenu({
  editor,
  blocks,
  compact,
}: {
  editor: Editor;
  blocks: EditorAction[];
  compact?: boolean;
}) {
  const currentId = useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      blocks.find((entry) => entry.isActive?.(instance))?.id ?? "paragraph",
  });
  if (blocks.length === 0) return null;
  const current = blocks.find((entry) => entry.id === currentId);
  const Icon = current?.icon ?? IconLetterT;

  return (
    <Dropdown>
      <Dropdown.Trigger
        render={
          <Button
            size="sm"
            variant="ghost"
            icon={Icon}
            iconEnd={IconChevronDown}
            aria-label="Turn into"
          >
            {compact ? null : (current?.label ?? "Text")}
          </Button>
        }
      />
      <Dropdown.Content align="start" className="w-48">
        <Dropdown.Group>
          <Dropdown.Label>Turn into</Dropdown.Label>
          {blocks.map((entry) => (
            <Dropdown.Item
              key={entry.id}
              icon={entry.icon}
              onClick={() => entry.run(editor)}
            >
              {entry.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Group>
      </Dropdown.Content>
    </Dropdown>
  );
}

function ActionButton({
  editor,
  action,
}: {
  editor: Editor;
  action: EditorAction;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      active: action.isActive?.(instance) === true,
      disabled: action.isDisabled?.(instance) === true,
    }),
  });
  const active = state?.active === true;
  return (
    <Tooltip content={action.label}>
      <Button
        size="sm"
        shape="square"
        variant={active ? "secondary" : "ghost"}
        icon={action.icon}
        aria-label={action.label}
        aria-pressed={active}
        disabled={state?.disabled === true}
        onClick={() => action.run(editor)}
      />
    </Tooltip>
  );
}

function LinkButton({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance.isActive("link"),
  });
  return (
    <Button
      size="sm"
      shape="square"
      variant={active ? "secondary" : "ghost"}
      icon={IconLink}
      aria-label="Link"
    />
  );
}

/**
 * The image panel.
 *
 * Alternative text is a field rather than a dialog because it is the one
 * thing about an image that is nearly always missing and nearly always
 * someone else's problem by the time anybody notices.
 */
function ImagePanel({
  editor,
  onReplace,
}: {
  editor: Editor;
  onReplace: () => void;
}) {
  const attributes = useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      instance.getAttributes("image") as {
        alt?: string;
        title?: string;
        src?: string;
      },
  });

  return (
    <div className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl bg-heyo-overlay p-3 shadow-lg ring-1 ring-heyo-line">
      <Input
        size="sm"
        value={attributes.alt ?? ""}
        placeholder="Alternative text"
        aria-label="Alternative text"
        onChange={(event) =>
          editor
            .chain()
            .focus()
            .updateAttributes("image", { alt: event.target.value })
            .run()
        }
      />
      <Input
        size="sm"
        value={attributes.title ?? ""}
        placeholder="Caption"
        aria-label="Caption"
        onChange={(event) =>
          editor
            .chain()
            .focus()
            .updateAttributes("image", { title: event.target.value })
            .run()
        }
      />
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          icon={IconRefresh}
          onClick={onReplace}
        >
          Replace
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={IconPhoto}
          nativeButton={false}
          render={
            <a
              href={attributes.src ?? "#"}
              target="_blank"
              rel="noreferrer noopener"
            />
          }
        >
          Open
        </Button>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          shape="square"
          icon={IconTrash}
          aria-label="Remove image"
          onClick={() => editor.chain().focus().deleteSelection().run()}
        />
      </div>
      <Text size="xs" tone="subtle">
        The file stays in the library; removing it here only drops the
        reference.
      </Text>
    </div>
  );
}
