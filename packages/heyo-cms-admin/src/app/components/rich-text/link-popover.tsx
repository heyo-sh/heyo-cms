import { Button, Input, Popover, Text } from "@heyo-sh/heyo-ui";
import { IconExternalLink, IconLink, IconLinkOff } from "@tabler/icons-react";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";

/**
 * The link control: a popover, not a `window.prompt`.
 *
 * The prompt was the one place in the panel where an editor was asked to
 * type a URL into a browser dialog with no sight of the text it belonged to,
 * no way to open the existing link and no way to remove one without clearing
 * a field. This is the same three operations with the selection still on
 * screen behind it.
 */
export function LinkPopover({
  editor,
  trigger,
}: {
  editor: Editor;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const active = editor.isActive("link");

  useEffect(() => {
    if (!open) return;
    const current = editor.getAttributes("link").href as string | undefined;
    setHref(current ?? "");
  }, [open, editor]);

  const apply = () => {
    const value = href.trim();
    if (value === "") {
      editor.chain().focus().unsetLink().run();
    } else {
      // With no selection there is no text for the link mark to decorate.
      // Insert the URL itself (as Paragraph does), unless we are editing an
      // existing link at the caret — then only update that link's href.
      const insertUrl =
        editor.state.selection.empty && !editor.isActive("link");
      const chain = editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: value });
      if (insertUrl) chain.insertContent({ type: "text", text: value });
      chain.run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Content className="w-80 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            size="sm"
            icon={IconLink}
            value={href}
            placeholder="https://example.com"
            aria-label="Link URL"
            className="flex-1"
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              }
              if (event.key === "Escape") setOpen(false);
            }}
          />
          <Button size="sm" onClick={apply}>
            {active ? "Update" : "Add"}
          </Button>
        </div>

        {active ? (
          <div className="mt-2 flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              icon={IconExternalLink}
              nativeButton={false}
              render={
                <a
                  href={href || "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                />
              }
            >
              Open
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={IconLinkOff}
              onClick={() => {
                editor
                  .chain()
                  .focus()
                  .extendMarkRange("link")
                  .unsetLink()
                  .run();
                setOpen(false);
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <Text size="xs" tone="subtle" className="mt-2">
            Links never open while editing — a click here would navigate away
            from unsaved work.
          </Text>
        )}
      </Popover.Content>
    </Popover>
  );
}
