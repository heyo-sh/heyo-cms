import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Editor, JSONContent } from "@tiptap/core";

import { richTextToHtml, richTextToMarkdown } from "../../heyo-cms/src/editor";
import type { RichTextDocument } from "../../heyo-cms/src/types/editor";

// These are the actual commands used by the toolbar, selection bubble and
// slash menu, tested against the same TipTap extensions as the panel. Button
// presence alone would not catch a command that writes the wrong document.
let actions: typeof import("../src/app/components/rich-text/toolbar-items");
let createEditor: () => Editor;
let editor: Editor;

beforeAll(async () => {
  GlobalRegistrator.register();
  const { Editor: TiptapEditor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { TableKit } = await import("@tiptap/extension-table");
  const { default: TaskList } = await import("@tiptap/extension-task-list");
  const { default: TaskItem } = await import("@tiptap/extension-task-item");
  const { default: Image } = await import("@tiptap/extension-image");
  actions = await import("../src/app/components/rich-text/toolbar-items");
  createEditor = () =>
    new TiptapEditor({
      extensions: [
        StarterKit.configure({
          link: { openOnClick: false, autolink: true },
          heading: { levels: [1, 2, 3, 4] },
        }),
        TableKit.configure({ table: { resizable: true } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ inline: false }),
      ],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      },
    });
});

beforeEach(() => {
  editor = createEditor();
});
afterEach(() => editor.destroy());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function action(id: string) {
  const entry = [
    ...actions.blockActions,
    ...actions.markActions,
    ...actions.listActions,
    ...actions.insertActions,
    ...actions.tableActions,
  ].find((item) => item.id === id);
  if (!entry) throw new Error(`No action ${id}`);
  return entry;
}

function doc(): JSONContent {
  return editor.getJSON();
}

function html(): string {
  return richTextToHtml(doc() as RichTextDocument);
}

function markdown(): string {
  return richTextToMarkdown(doc() as RichTextDocument);
}

function selectWord(): void {
  editor.commands.setTextSelection({ from: 1, to: 6 });
}

function table(): JSONContent | undefined {
  return doc().content?.find((node) => node.type === "table");
}

describe("rich-text toolbar commands", () => {
  const marks: Array<[string, string]> = [
    ["bold", "strong"],
    ["italic", "em"],
    ["underline", "u"],
    ["strike", "s"],
    ["code", "code"],
  ];
  for (const [id, tag] of marks) {
    test(`${id} applies to selected text, serializes and toggles off`, () => {
      selectWord();
      action(id).run(editor);
      expect(action(id).isActive?.(editor)).toBe(true);
      expect(doc().content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe(id);
      expect(html()).toContain(`<${tag}>Hello</${tag}>`);
      action(id).run(editor);
      expect(action(id).isActive?.(editor)).toBe(false);
      expect(html()).toBe("<p>Hello world</p>");
    });
  }

  test("combining marks and removing one preserves the other", () => {
    selectWord();
    action("bold").run(editor);
    action("italic").run(editor);
    expect(doc().content?.[0]?.content?.[0]?.marks?.map((mark) => mark.type)).toEqual(["bold", "italic"]); // prettier-ignore
    action("bold").run(editor);
    expect(doc().content?.[0]?.content?.[0]?.marks?.map((mark) => mark.type)).toEqual(["italic"]); // prettier-ignore
  });

  for (const level of [1, 2, 3, 4]) {
    test(`heading ${level} changes the block and toggles back to text`, () => {
      const heading = action(`heading${level}`);
      heading.run(editor);
      expect(heading.isActive?.(editor)).toBe(true);
      expect(doc().content?.[0]).toMatchObject({
        type: "heading",
        attrs: { level },
      });
      // StarterKit adds an empty trailing paragraph so writing can continue.
      expect(html()).toStartWith(`<h${level}>Hello world</h${level}>`);
      heading.run(editor);
      expect(doc().content?.[0]?.type).toBe("paragraph");
    });
  }

  const lists: Array<[string, string]> = [
    ["bulletList", "ul"],
    ["orderedList", "ol"],
    ["taskList", "ul"],
  ];
  for (const [id, tag] of lists) {
    test(`${id} wraps text in the right node and toggles off`, () => {
      action(id).run(editor);
      expect(doc().content?.[0]?.type).toBe(id);
      expect(html()).toStartWith(`<${tag}`);
      action(id).run(editor);
      expect(doc().content?.[0]?.type).toBe("paragraph");
    });
  }

  test("checking and unchecking a task changes the stored JSON", () => {
    action("taskList").run(editor);
    const checkbox = editor.view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]'); // prettier-ignore
    if (!checkbox) throw new Error("TaskItem did not render a checkbox");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc().content?.[0]?.content?.[0]?.attrs?.checked).toBe(true);
    expect(markdown()).toContain("- [x] Hello world");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(doc().content?.[0]?.content?.[0]?.attrs?.checked).toBe(false);
  });

  test("quote, code block and divider produce serializable content", () => {
    action("blockquote").run(editor);
    expect(markdown()).toBe("> Hello world");
    action("blockquote").run(editor);
    action("codeBlock").run(editor);
    expect(html()).toStartWith("<pre><code>Hello world</code></pre>");
    expect(markdown()).toStartWith("```\nHello world\n```");
    action("codeBlock").run(editor);
    action("horizontalRule").run(editor);
    expect(html()).toContain("<hr>");
  });

  test("table inserts cells and all row/column/remove actions work", () => {
    action("table").run(editor);
    expect(table()?.content).toHaveLength(3);
    expect(html()).toContain("<table>");
    action("addRowBefore").run(editor);
    expect(table()?.content).toHaveLength(4);
    action("deleteRow").run(editor);
    expect(table()?.content).toHaveLength(3);
    action("addRowAfter").run(editor);
    expect(table()?.content).toHaveLength(4);
    action("deleteRow").run(editor);
    expect(table()?.content).toHaveLength(3);
    action("addColumnBefore").run(editor);
    expect(table()?.content?.[0]?.content).toHaveLength(4);
    action("deleteColumn").run(editor);
    expect(table()?.content?.[0]?.content).toHaveLength(3);
    action("addColumnAfter").run(editor);
    expect(table()?.content?.[0]?.content).toHaveLength(4);
    action("deleteColumn").run(editor);
    expect(table()?.content?.[0]?.content).toHaveLength(3);
    action("deleteTable").run(editor);
    expect(table()).toBeUndefined();
  });

  test("paragraph, undo and redo restore the expected block", () => {
    action("heading2").run(editor);
    expect(doc().content?.[0]?.type).toBe("heading");
    editor.commands.undo();
    expect(doc().content?.[0]?.type).toBe("paragraph");
    editor.commands.redo();
    expect(doc().content?.[0]?.type).toBe("heading");
    action("paragraph").run(editor);
    expect(doc().content?.[0]?.type).toBe("paragraph");
  });

  test("image action opens the picker rather than inserting a URL without mediaId", () => {
    let opened = false;
    actions
      .imageAction(() => {
        opened = true;
      })
      .run(editor);
    expect(opened).toBe(true);
    expect(doc().content?.[0]?.type).toBe("paragraph");
  });

  test("link popover adds, updates and removes links (also at an empty caret)", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; // prettier-ignore
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { LinkPopover } =
      await import("../src/app/components/rich-text/link-popover");
    const container = document.createElement("div");
    document.body.append(container);
    container.append(editor.view.dom);
    const root = createRoot(
      container.appendChild(document.createElement("div")),
    );
    await act(async () => {
      root.render(
        createElement(LinkPopover, {
          editor,
          trigger: createElement("button", { type: "button" }, "Link"),
        }),
      );
    });

    async function click(element: Element | null) {
      if (!element) throw new Error("Expected a link popover control");
      await act(async () => {
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); // prettier-ignore
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); // prettier-ignore
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    async function enterLink(value: string) {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Link URL"]'); // prettier-ignore
      if (!input) throw new Error("Link URL input did not open");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; // prettier-ignore
      await act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    async function open() {
      await click(container.querySelector("button"));
      expect(document.querySelector('[aria-label="Link URL"]')).not.toBeNull(); // prettier-ignore
    }

    try {
      selectWord();
      await open();
      await enterLink("https://example.com");
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null); // prettier-ignore
      expect(html()).toContain('<a href="https://example.com"');
      expect(html()).toContain(">Hello</a>");

      editor.commands.setTextSelection(3);
      await open();
      await enterLink("https://example.org");
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Update") ?? null); // prettier-ignore
      expect(html()).toContain('<a href="https://example.org"');
      await open();
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Remove") ?? null); // prettier-ignore
      expect(html()).not.toContain("<a ");

      editor.commands.setTextSelection(12);
      await open();
      await enterLink("https://example.net");
      await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null); // prettier-ignore
      expect(html()).toContain(">https://example.net</a>");
      expect(markdown()).toContain(
        "[https://example.net](https://example.net)",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
