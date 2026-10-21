import type { Editor } from "@tiptap/core";
import {
  IconBlockquote,
  IconBold,
  IconCode,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconColumnRemove,
  IconH1,
  IconH2,
  IconH3,
  IconH4,
  IconItalic,
  IconLetterT,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconMinus,
  IconPhoto,
  IconRowInsertBottom,
  IconRowInsertTop,
  IconRowRemove,
  IconSourceCode,
  IconStrikethrough,
  IconTable,
  IconTableOff,
  IconUnderline,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

/**
 * What the editor can do, as data.
 *
 * The toolbar, the bubble menu and the slash list are three renderings of one
 * list, which is the only way they stay in agreement: a block added here
 * appears in all three, and "the slash menu can insert a table the toolbar
 * cannot" stops being a thing that can happen.
 */

export interface EditorAction {
  /** Stable key, also the node name `richText({ nodes })` filters on. */
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Extra words the slash menu matches on. */
  keywords?: string[];
  run: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
  isDisabled?: (editor: Editor) => boolean;
}

/** The block the caret is in — what the "Turn into" menu reads. */
export const blockActions: EditorAction[] = [
  {
    id: "paragraph",
    label: "Text",
    icon: IconLetterT,
    keywords: ["paragraph", "body", "p"],
    run: (editor) => editor.chain().focus().setParagraph().run(),
    isActive: (editor) =>
      editor.isActive("paragraph") && !editor.isActive("listItem"),
  },
  {
    id: "heading1",
    label: "Heading 1",
    icon: IconH1,
    keywords: ["h1", "title"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 1 }),
  },
  {
    id: "heading2",
    label: "Heading 2",
    icon: IconH2,
    keywords: ["h2", "section"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
  },
  {
    id: "heading3",
    label: "Heading 3",
    icon: IconH3,
    keywords: ["h3"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 3 }),
  },
  {
    id: "heading4",
    label: "Heading 4",
    icon: IconH4,
    keywords: ["h4"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 4 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 4 }),
  },
];

export const markActions: EditorAction[] = [
  {
    id: "bold",
    label: "Bold",
    icon: IconBold,
    keywords: ["strong"],
    run: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor) => editor.isActive("bold"),
  },
  {
    id: "italic",
    label: "Italic",
    icon: IconItalic,
    keywords: ["emphasis"],
    run: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor) => editor.isActive("italic"),
  },
  {
    id: "underline",
    label: "Underline",
    icon: IconUnderline,
    run: (editor) => editor.chain().focus().toggleUnderline().run(),
    isActive: (editor) => editor.isActive("underline"),
  },
  {
    id: "strike",
    label: "Strikethrough",
    icon: IconStrikethrough,
    run: (editor) => editor.chain().focus().toggleStrike().run(),
    isActive: (editor) => editor.isActive("strike"),
  },
  {
    id: "code",
    label: "Code",
    icon: IconCode,
    keywords: ["inline code", "mono"],
    run: (editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor) => editor.isActive("code"),
  },
];

export const listActions: EditorAction[] = [
  {
    id: "bulletList",
    label: "Bulleted list",
    icon: IconList,
    keywords: ["ul", "unordered"],
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: (editor) => editor.isActive("bulletList"),
  },
  {
    id: "orderedList",
    label: "Numbered list",
    icon: IconListNumbers,
    keywords: ["ol", "ordered"],
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive("orderedList"),
  },
  {
    id: "taskList",
    label: "Task list",
    icon: IconListCheck,
    keywords: ["todo", "checkbox"],
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
    isActive: (editor) => editor.isActive("taskList"),
  },
];

export const insertActions: EditorAction[] = [
  {
    id: "blockquote",
    label: "Quote",
    icon: IconBlockquote,
    keywords: ["cite", "blockquote"],
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive("blockquote"),
  },
  {
    id: "codeBlock",
    label: "Code block",
    icon: IconSourceCode,
    keywords: ["pre", "snippet"],
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    isActive: (editor) => editor.isActive("codeBlock"),
  },
  {
    id: "table",
    label: "Table",
    icon: IconTable,
    keywords: ["grid"],
    run: (editor) =>
      editor
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
    isActive: (editor) => editor.isActive("table"),
  },
  {
    id: "horizontalRule",
    label: "Divider",
    icon: IconMinus,
    keywords: ["hr", "rule", "separator"],
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

/** The image entry needs the picker, so it is built where the picker lives. */
export function imageAction(open: () => void): EditorAction {
  return {
    id: "image",
    label: "Image",
    icon: IconPhoto,
    keywords: ["media", "photo", "picture"],
    run: open,
  };
}

export const tableActions: EditorAction[] = [
  {
    id: "addRowBefore",
    label: "Row above",
    icon: IconRowInsertTop,
    run: (editor) => editor.chain().focus().addRowBefore().run(),
  },
  {
    id: "addRowAfter",
    label: "Row below",
    icon: IconRowInsertBottom,
    run: (editor) => editor.chain().focus().addRowAfter().run(),
  },
  {
    id: "deleteRow",
    label: "Delete row",
    icon: IconRowRemove,
    run: (editor) => editor.chain().focus().deleteRow().run(),
  },
  {
    id: "addColumnBefore",
    label: "Column left",
    icon: IconColumnInsertLeft,
    run: (editor) => editor.chain().focus().addColumnBefore().run(),
  },
  {
    id: "addColumnAfter",
    label: "Column right",
    icon: IconColumnInsertRight,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  {
    id: "deleteColumn",
    label: "Delete column",
    icon: IconColumnRemove,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
  },
  {
    id: "deleteTable",
    label: "Delete table",
    icon: IconTableOff,
    run: (editor) => editor.chain().focus().deleteTable().run(),
  },
];
